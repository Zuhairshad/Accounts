import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database, Transaction } from "@/db";
import {
  accounts, auditLogs, companies, financialYears, invoiceLines, invoices, items, journalLines,
  legacyImportRecords, legacyImports, operationHistory, parties, periods, stockMoves, units, users, voucherDocuments, vouchers,
} from "@/db/schema";
import { AccountingError, Exact, manualVoucher } from "@/lib/engine/model";
import { saveManual } from "@/lib/engine/vouchers";
import { advanceSequences, reportHash, verify, type Approval, type Report } from "./load";
import { normalize, type Dataset, type Issue, type LegacyVoucher } from "./normalize";
import type { LegacySource, Mapping } from "./source";

/*
 * Delta merge of a newer backup of the same desktop database into books that already hold a committed legacy import.
 *
 * The base backup must be the exact source of a committed import (its SHA-256 is recorded), so the difference between
 * base and source is exactly what the desktop application recorded since. New accounts, parties, items, vouchers and
 * invoices are imported with the same rules as the full importer. A voucher edited in the desktop application after
 * the base import is revised through the application's own posted-voucher revision path, so the change has a reason
 * and an audit trail. Anything the delta cannot reproduce faithfully (deleted or edited master records, edited
 * invoices, backdated stock, activity entered directly in the web application) is fatal: nothing is merged.
 *
 * Every run verifies the complete source against the complete target (trial balance per account, party balances,
 * invoice totals, record counts and the application's Financial reconciliation), exactly like the full importer.
 */

type Decimal = InstanceType<typeof Exact>;
const d = (value: string | number | Decimal) => new Exact(value.toString());
const PENDING = "00000000-0000-4000-8000-000000000001";
const chunk = <T,>(rows: T[], size = 400) => Array.from({ length: Math.ceil(rows.length / size) }, (_, i) => rows.slice(i * size, i * size + size));
const compareIds = (a: string, b: string) => (/^\d+$/.test(a) && /^\d+$/.test(b) ? Number(a) - Number(b) : a.localeCompare(b));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const monthStart = (date: string) => `${date.slice(0, 7)}-01`;
function monthEnd(date: string) {
  const [y, m] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
function fiscalYear(date: string, startMonth: number) {
  const [y, m] = date.split("-").map(Number);
  const start = m >= startMonth ? y : y - 1;
  const next = new Date(Date.UTC(start + 1, startMonth - 1, 1));
  return { startsOn: `${start}-${String(startMonth).padStart(2, "0")}-01`, endsOn: new Date(next.getTime() - 86_400_000).toISOString().slice(0, 10),
    name: startMonth === 1 ? `FY ${start}` : `FY ${start}-${String(start + 1).slice(2)}` };
}

export type DeltaReport = Report & {
  base: { sha256: string; importId: string };
  revisions: { company: string; voucher: string; before: string; after: string }[];
};
export type DeltaResult = { status: "fatal" | "dry-run" | "committed" | "refused"; report: DeltaReport; reportSha256: string; reasons: string[]; importId?: string };
class Abort extends Error { constructor(readonly result: DeltaResult) { super(result.status); } }

const voucherShape = (v: LegacyVoucher) => ({ number: v.number, date: v.date, type: v.type, narration: v.narration, quarantine: v.quarantine ?? null,
  lines: v.lines.map(({ lineNo, account, party, item, debit, credit, description }) => ({ lineNo, account, party, item: item ?? null, debit, credit, description })) });
const lineSummary = (v: LegacyVoucher, accountName: (legacy: string) => string) =>
  v.lines.map((l) => `${accountName(l.account)} ${d(l.debit).gt(0) ? `Dr ${l.debit}` : `Cr ${l.credit}`}`).join("; ");

export async function runLegacyDelta(db: Database, base: LegacySource, source: LegacySource, mapping: Mapping, mappingSha256: string,
  options: { mode: "dry-run" | "import"; actor: string; approval?: Approval }): Promise<DeltaResult> {
  const problems = [...base.validate(mapping).problems, ...source.validate(mapping).problems];
  const read = (src: LegacySource) => normalize(mapping, (entity) => src.read(mapping, entity));
  const empty = (): Dataset => ({ companies: [], accounts: [], parties: [], items: [], vouchers: [], invoices: [], orphanLines: [], issues: [], sourceCounts: {} });
  const old = problems.length ? empty() : read(base);
  const data = problems.length ? empty() : read(source);
  for (const problem of problems) data.issues.push({ code: "mapping-mismatch", severity: "fatal", entity: "mapping", legacyId: problem, message: problem, resolution: "Correct the mapping file." });

  try {
    return await db.transaction(async (tx) => {
      const report = await plan(tx, old, data, mapping, options.actor, base.sha256, source.sha256);
      report.source = { sha256: source.sha256, bytes: source.bytes, signature: source.schema().signature, counts: data.sourceCounts };
      report.mappingSha256 = mappingSha256;
      report.profile = mapping.profile;
      const hash = () => reportHash(report);
      const fatal = report.issues.filter((i) => i.severity === "fatal");
      if (fatal.length) throw new Abort({ status: "fatal", report, reportSha256: hash(), reasons: fatal.map((i) => `${i.code} (${i.count})`) });
      if (report.verification.unexplained) throw new Abort({ status: "fatal", report, reportSha256: hash(), reasons: [`${report.verification.unexplained} unexplained source/target differences`] });
      const reportSha256 = hash();
      if (options.mode === "dry-run") throw new Abort({ status: "dry-run", report, reportSha256, reasons: ["Dry run: every change was rolled back."] });
      const reasons = approvalProblems(options.approval, report, reportSha256);
      if (reasons.length) throw new Abort({ status: "refused", report, reportSha256, reasons });
      const [record] = await tx.insert(legacyImports).values({
        sourceSha256: source.sha256, mappingSha256, reportSha256, approvedBy: options.approval!.approvedBy,
        approval: { ...options.approval!, kind: "delta", baseImportId: report.base.importId, baseSha256: report.base.sha256 },
        summary: { kind: "delta", base: report.base, outcome: report.outcome, companies: report.companies, revisions: report.revisions, verification: report.verification },
      }).returning();
      await tx.execute(sql`UPDATE legacy_import_records SET import_id=${record.id} WHERE import_id=${PENDING}`);
      await tx.execute(sql`DELETE FROM legacy_imports WHERE id=${PENDING}`);
      await tx.insert(operationHistory).values({ kind: "legacy_import", reference: record.id, status: "committed",
        details: { kind: "delta", baseSha256: base.sha256, sourceSha256: source.sha256, reportSha256, approvedBy: options.approval!.approvedBy } });
      return { status: "committed" as const, report, reportSha256, reasons: [], importId: record.id };
    }, { isolationLevel: "serializable" });
  } catch (error) {
    if (error instanceof Abort) return error.result;
    throw error;
  }
}

function approvalProblems(approval: Approval | undefined, report: Report, reportSha256: string) {
  if (!approval) return ["An approval file is required to import."];
  const reasons: string[] = [];
  if (!approval.approvedBy?.trim() || !approval.role?.trim() || !approval.notes?.trim()) reasons.push("Approval must name the approver, their role and notes.");
  if (approval.reportSha256 !== reportSha256) reasons.push("Approval does not match this exact dry-run report. Re-run the dry run and approve its report hash.");
  const required = Object.fromEntries(report.issues.filter((i) => i.severity === "blocking" || i.severity === "review").map((i) => [i.code, i.count]));
  for (const [code, count] of Object.entries(required)) if (approval.accepted?.[code] !== count) reasons.push(`Approval must accept ${count} × ${code}.`);
  for (const code of Object.keys(approval.accepted ?? {})) if (!(code in required)) reasons.push(`Approval lists ${code}, which this report does not contain.`);
  return reasons;
}

async function plan(tx: Transaction, old: Dataset, data: Dataset, mapping: Mapping, actorName: string, baseSha: string, sourceSha: string): Promise<DeltaReport> {
  // Issues from normalizing the full source concern records that were already imported; only new and revised records'
  // issues are reported again (filtered below), so an approval covers exactly what this merge changes.
  const sourceIssues = data.issues;
  const issues: Issue[] = sourceIssues.filter((i) => i.severity === "fatal");
  const fatal = (code: string, message: string, legacyId = "", company?: string) =>
    issues.push({ code, severity: "fatal", entity: "plan", legacyId, company, message, resolution: "Resolve before merging; this cannot be approved." });
  const outcome: Report["outcome"] = {};
  const records: (typeof legacyImportRecords.$inferInsert)[] = [];
  const record = (companyId: string | null, entity: string, legacyId: string, targetId: string | null, result: "imported" | "reused") => {
    outcome[entity] ??= {};
    outcome[entity][result] = (outcome[entity][result] ?? 0) + 1;
    records.push({ importId: PENDING, companyId, entity, legacyId, targetId, outcome: result });
  };
  const report: DeltaReport = {
    source: { sha256: sourceSha, bytes: 0, signature: "", counts: {} }, mappingSha256: "", profile: "", issues: [], details: [], companies: [], outcome,
    verification: { differences: [], unexplained: 0, reconciliation: {} }, inventory: [], manualReconciliation: [],
    base: { sha256: baseSha, importId: "" }, revisions: [],
  };
  const finish = () => {
    const grouped = new Map<string, { code: string; severity: Issue["severity"]; count: number; resolution: string }>();
    for (const issue of issues) {
      const entry = grouped.get(issue.code) ?? { code: issue.code, severity: issue.severity, count: 0, resolution: issue.resolution };
      entry.count++;
      grouped.set(issue.code, entry);
    }
    report.issues = [...grouped.values()].sort((a, b) => a.code.localeCompare(b.code));
    report.details = issues;
    return report;
  };

  await tx.insert(legacyImports).values({ id: PENDING, sourceSha256: `pending:${sourceSha}`, mappingSha256: "", reportSha256: "", approvedBy: "pending", approval: {}, summary: {} });
  const [actor] = await tx.select().from(users).where(eq(users.username, actorName));
  if (!actor?.active || !actor.superAdmin) fatal("actor-not-authorized", `Operator "${actorName}" must be an active Super Admin.`);
  const committed = await tx.select().from(legacyImports).where(eq(legacyImports.status, "committed"));
  const baseImport = committed.find((i) => i.sourceSha256 === baseSha);
  // The base must be the most recent merge into its companies; an older backup would re-add what a later merge added.
  const [superseded] = baseImport ? (await tx.execute<{ id: string }>(sql`
    SELECT DISTINCT later.id FROM legacy_imports later JOIN legacy_import_records r ON r.import_id=later.id
    WHERE later.status='committed' AND later.created_at>(SELECT created_at FROM legacy_imports WHERE id=${baseImport.id})
      AND r.company_id IN (SELECT company_id FROM legacy_import_records WHERE import_id=${baseImport.id} AND company_id IS NOT NULL)`)).rows : [];
  if (!baseImport || superseded) fatal("base-not-imported", "The base backup must be the most recently merged backup of these companies. The delta would not be exact.");
  else report.base.importId = baseImport.id;
  if (committed.some((i) => i.sourceSha256 === sourceSha)) fatal("already-imported", "This exact source database was already imported.");
  if (issues.some((i) => i.severity === "fatal") || !actor) return finish();

  /* Identifier map from the base's chain of imports: the full import plus the deltas merged on top of it. Legacy ids are
     only unique within one desktop database, so other imports (other databases) must not be consulted. */
  const chain: string[] = [];
  for (let at = baseImport as typeof baseImport | undefined; at && !chain.includes(at.id);
    at = committed.find((i) => i.id === (at!.approval as { baseImportId?: string }).baseImportId)) chain.push(at.id);
  const mapped = await tx.select().from(legacyImportRecords).where(inArray(legacyImportRecords.importId, chain));
  const target = new Map(mapped.filter((r) => r.targetId).map((r) => [`${r.entity}|${r.legacyId}`, r.targetId!]));
  const has = (entity: string, legacyId: string) => target.has(`${entity}|${legacyId}`);

  /* Companies are unchanged and already mapped. */
  if (!same(old.companies, data.companies)) fatal("companies-changed", "The company list differs between base and source.");
  const companyTarget = new Map<string, string>();
  for (const company of data.companies) {
    const id = target.get(`company|${company.legacyId}`);
    if (!id) { fatal("company-unmapped", `Legacy company ${company.name} has no target.`, company.legacyId); continue; }
    companyTarget.set(company.legacyId, id);
    const [row] = await tx.select().from(companies).where(eq(companies.id, id)).for("update");
    report.companies.push({ legacyId: company.legacyId, legacyName: company.name, target: row.name, created: false });
  }
  if (issues.some((i) => i.severity === "fatal")) return finish();
  const companyOf = (legacy: string) => companyTarget.get(legacy)!;

  /* The target must hold nothing but imported legacy data, so nothing entered in the web application can be duplicated. */
  const ids = [...companyTarget.values()];
  const inCompanies = sql.join(ids.map((id) => sql`${id}::uuid`), sql`,`);
  const [foreign] = (await tx.execute<{ vouchers: string; invoices: string; parties: string; items: string }>(sql`SELECT
    (SELECT count(*) FROM effective_vouchers e WHERE e.company_id IN (${inCompanies}) AND NOT EXISTS (SELECT 1 FROM legacy_import_records r
      WHERE r.target_id=e.document_id AND r.entity IN ('voucher','stock_opening_voucher')))::text AS vouchers,
    (SELECT count(*) FROM invoices i WHERE i.company_id IN (${inCompanies}) AND NOT EXISTS (SELECT 1 FROM legacy_import_records r WHERE r.target_id=i.id))::text AS invoices,
    (SELECT count(*) FROM parties p WHERE p.company_id IN (${inCompanies}) AND NOT EXISTS (SELECT 1 FROM legacy_import_records r WHERE r.target_id=p.id))::text AS parties,
    (SELECT count(*) FROM inventory_items p WHERE p.company_id IN (${inCompanies}) AND NOT EXISTS (SELECT 1 FROM legacy_import_records r WHERE r.target_id=p.id))::text AS items`)).rows;
  for (const [entity, n] of Object.entries(foreign)) {
    if (Number(n)) fatal("target-has-new-activity", `${n} ${entity} were entered in the web application after the import. Merge manually instead.`);
  }

  /* Master records that already exist must be unchanged; the delta only adds. */
  const diffMasters = <T extends { legacyId: string }>(entity: string, before: T[], after: T[]) => {
    const now = new Map(after.map((r) => [r.legacyId, r]));
    for (const row of before) {
      const next = now.get(row.legacyId);
      if (!next) fatal(`${entity}-deleted`, `Legacy ${entity} ${row.legacyId} was deleted in the desktop application.`, row.legacyId);
      else if (!same(row, next)) fatal(`${entity}-changed`, `Legacy ${entity} ${row.legacyId} changed: ${JSON.stringify(row)} → ${JSON.stringify(next)}.`, row.legacyId);
    }
    const known = new Set(before.map((r) => r.legacyId));
    return after.filter((r) => !known.has(r.legacyId));
  };
  const newAccounts = diffMasters("account", old.accounts, data.accounts);
  const newParties = diffMasters("party", old.parties, data.parties);
  const newItems = diffMasters("item", old.items, data.items);
  for (const item of newItems) if (!d(item.openingQty).isZero()) fatal("new-item-opening-stock", `New item "${item.name}" has opening stock; enter it as an approved adjustment.`, item.legacyId, item.company);

  const oldVouchers = new Map(old.vouchers.map((v) => [v.legacyId, v]));
  const newVouchers: LegacyVoucher[] = [];
  const revised: LegacyVoucher[] = [];
  for (const v of old.vouchers) if (!data.vouchers.some((n) => n.legacyId === v.legacyId)) fatal("voucher-deleted", `Voucher ${v.number} was deleted in the desktop application.`, v.legacyId, v.company);
  for (const v of data.vouchers) {
    const before = oldVouchers.get(v.legacyId);
    if (!before) { newVouchers.push(v); continue; }
    if (same(voucherShape(before), voucherShape(v))) continue;
    const header = (x: LegacyVoucher) => ({ number: x.number, date: x.date, type: x.type, narration: x.narration });
    if (!same(header(before), header(v)) || before.quarantine || v.quarantine) {
      fatal("voucher-header-changed", `Voucher ${v.number} changed its number, date, type or narration, or is quarantined.`, v.legacyId, v.company);
    } else revised.push(v);
  }
  const oldInvoices = new Map(old.invoices.map((i) => [i.key, i]));
  const invoiceShape = (i: Dataset["invoices"][number]) => ({ ...i, rows: undefined });
  for (const i of old.invoices) {
    const next = data.invoices.find((n) => n.key === i.key);
    if (!next) fatal("invoice-deleted", `Invoice ${i.number} was deleted in the desktop application.`, i.key, i.company);
    else if (!same(invoiceShape(i), invoiceShape(next))) fatal("invoice-changed", `Invoice ${i.number} changed in the desktop application.`, i.key, i.company);
  }
  const newInvoices = data.invoices.filter((i) => !oldInvoices.has(i.key));
  for (const v of revised) {
    if (await tx.select({ id: invoices.id }).from(invoices).where(eq(invoices.voucherId, target.get(`voucher|${v.legacyId}`)!)).then((r) => r.length)) {
      fatal("revised-invoice-voucher", `Voucher ${v.number} belongs to an invoice; it cannot be revised as a manual voucher.`, v.legacyId, v.company);
    }
    if (v.lines.some((l) => l.item)) fatal("revised-inventory-voucher", `Voucher ${v.number} has inventory lines and cannot be revised as a manual voucher.`, v.legacyId, v.company);
  }
  const touched = new Set([...newVouchers, ...revised].map((v) => v.legacyId));
  const touchedInvoices = new Set(newInvoices.map((i) => i.key));
  issues.push(...sourceIssues.filter((i) => i.severity !== "fatal" && (
    (i.entity === "voucher" && touched.has(i.legacyId)) || (i.entity === "invoice" && touchedInvoices.has(i.legacyId)) ||
    (i.entity === "party" && newParties.some((p) => p.legacyId === i.legacyId)) || (i.entity === "item" && newItems.some((p) => p.legacyId === i.legacyId)))));
  for (const v of newVouchers) if (v.quarantine && v.quarantine !== "empty-voucher") fatal("new-voucher-quarantined", `New voucher ${v.number} cannot be imported (${v.quarantine}).`, v.legacyId, v.company);
  for (const i of newInvoices) if (i.quarantine) fatal("new-invoice-quarantined", `New invoice ${i.number} cannot be imported (${i.quarantine}).`, i.key, i.company);
  if (issues.some((i) => i.severity === "fatal")) return finish();

  /* Accounts: same rule as the full import (reuse by code with the same type; a name-only match is a conflict). */
  const accountTarget = new Map<string, { id: string; control: string | null }>();
  const accountRows = await tx.select().from(accounts).where(inArray(accounts.companyId, ids));
  for (const account of old.accounts) {
    const id = target.get(`account|${account.legacyId}`)!;
    accountTarget.set(account.legacyId, { id, control: accountRows.find((a) => a.id === id)?.control ?? null });
  }
  const mappedAccountIds = new Set([...accountTarget.values()].map((a) => a.id));
  for (const account of newAccounts) {
    const companyId = companyOf(account.company);
    const byCode = accountRows.find((a) => a.companyId === companyId && a.code === account.code);
    if (byCode) {
      if (byCode.type !== account.type) { fatal("account-type-conflict", `Legacy account ${account.code} ${account.name} is ${account.type}; target is ${byCode.type}.`, account.legacyId, account.company); continue; }
      if (mappedAccountIds.has(byCode.id)) { fatal("duplicate-account-code", `Account code ${account.code} is already mapped to another legacy account.`, account.legacyId, account.company); continue; }
      mappedAccountIds.add(byCode.id);
      accountTarget.set(account.legacyId, { id: byCode.id, control: byCode.control });
      record(companyId, "account", account.legacyId, byCode.id, "reused");
      continue;
    }
    if (accountRows.some((a) => a.companyId === companyId && a.name.toLowerCase() === account.name.toLowerCase())) {
      fatal("account-name-conflict", `Legacy account ${account.code} "${account.name}" matches a target account by name only.`, account.legacyId, account.company); continue;
    }
    const [created] = await tx.insert(accounts).values({ companyId, code: account.code, name: account.name, type: account.type }).returning();
    accountRows.push(created);
    accountTarget.set(account.legacyId, { id: created.id, control: null });
    record(companyId, "account", account.legacyId, created.id, "imported");
  }
  if (issues.some((i) => i.severity === "fatal")) return finish();

  /* Parties */
  const partyTarget = new Map<string, string>(data.parties.filter((p) => has("party", p.legacyId)).map((p) => [p.legacyId, target.get(`party|${p.legacyId}`)!]));
  for (const party of newParties) {
    const companyId = companyOf(party.company);
    const [clash] = await tx.select({ id: parties.id }).from(parties).where(and(eq(parties.companyId, companyId), eq(parties.type, party.type), sql`lower(${parties.name})=lower(${party.importName})`));
    if (clash) { fatal("party-name-conflict", `${party.type} "${party.importName}" already exists in the target.`, party.legacyId, party.company); continue; }
    const [row] = await tx.insert(parties).values({ companyId, name: party.importName, type: party.type, phone: party.phone, address: party.address }).returning({ id: parties.id });
    partyTarget.set(party.legacyId, row.id);
    record(companyId, "party", party.legacyId, row.id, "imported");
  }

  /* Units (matched case-insensitively) and items */
  const itemTarget = new Map<string, string>(data.items.filter((i) => has("item", i.legacyId)).map((i) => [i.legacyId, target.get(`item|${i.legacyId}`)!]));
  for (const item of newItems) {
    const companyId = companyOf(item.company);
    let [unit] = await tx.select().from(units).where(and(eq(units.companyId, companyId), sql`lower(${units.name})=lower(${item.unit})`));
    unit ??= (await tx.insert(units).values({ companyId, name: item.unit }).returning())[0];
    const [clash] = await tx.select({ id: items.id }).from(items).where(and(eq(items.companyId, companyId), sql`lower(${items.name})=lower(${item.name})`));
    if (clash) { fatal("item-name-conflict", `Item "${item.name}" already exists in the target.`, item.legacyId, item.company); continue; }
    const [row] = await tx.insert(items).values({ companyId, unitId: unit.id, name: item.name, kind: "stock" }).returning({ id: items.id });
    itemTarget.set(item.legacyId, row.id);
    record(companyId, "item", item.legacyId, row.id, "imported");
  }
  if (issues.some((i) => i.severity === "fatal")) return finish();

  /* Party links follow the full importer: a party tag is valid only on its control account. Applied to the whole
     source so verification mirrors the target; issues are reported for new and revised vouchers only. */
  const partyById = new Map(data.parties.map((p) => [p.legacyId, p]));
  for (const voucher of data.vouchers) {
    if (voucher.quarantine) continue;
    for (const line of voucher.lines) {
      const control = accountTarget.get(line.account)?.control;
      const party = line.party ? partyById.get(line.party) : undefined;
      const fits = party && ((party.type === "customer" && control === "receivable") || (party.type === "supplier" && control === "payable"));
      if (party && !fits) {
        if (touched.has(voucher.legacyId)) issues.push({ code: "party-control-mismatch", severity: "blocking", entity: "voucher", legacyId: voucher.legacyId, company: voucher.company,
          message: `${voucher.number} line ${line.lineNo}: ${party.type} "${party.name}" is tagged on an account that is not its control account.`,
          resolution: "Import the amount unchanged without the party tag; the party name is kept in the line description." });
        line.unlinkedParty = party.name;
        line.description = `${line.description} [legacy party: ${party.name}]`.trim().slice(0, 1000);
        line.party = null;
      }
      if (touched.has(voucher.legacyId) && !line.party && (control === "receivable" || control === "payable")) {
        report.manualReconciliation.push({ company: voucher.company, voucher: voucher.number, line: line.lineNo, amount: d(line.debit).minus(line.credit).toFixed(2),
          reason: line.unlinkedParty ? "Party tag removed (wrong party type)" : "Control line without a customer or supplier" });
      }
    }
  }
  for (const entry of report.manualReconciliation) issues.push({ code: "unlinked-control-line", severity: "review", entity: "voucher", legacyId: `${entry.voucher}#${entry.line}`,
    company: entry.company, message: `${entry.voucher} line ${entry.line} (${entry.amount}) is on a control account without a party.`,
    resolution: "Import as recorded. Link it to the correct party through Legacy party voucher linking after review." });

  /* Accounting calendar for new dates. */
  const periodFor = new Map<string, string>();
  const dates = new Map<string, Set<string>>();
  for (const v of newVouchers.filter((v) => !v.quarantine)) dates.set(v.company, (dates.get(v.company) ?? new Set()).add(v.date));
  for (const [legacyCompany, set] of dates) {
    const companyId = companyOf(legacyCompany);
    const years = await tx.select().from(financialYears).where(eq(financialYears.companyId, companyId));
    const terms = await tx.select().from(periods).where(eq(periods.companyId, companyId));
    for (const date of [...set].sort()) {
      let year = years.find((y) => y.startsOn <= date && y.endsOn >= date);
      if (!year) { [year] = await tx.insert(financialYears).values({ companyId, ...fiscalYear(date, mapping.fiscalYearStartMonth) }).returning(); years.push(year); }
      if (year.closed) { fatal("closed-year", `Financial year ${year.name} is closed but ${date} must be merged into it.`, date, legacyCompany); continue; }
      let term = terms.find((p) => p.startsOn <= date && p.endsOn >= date);
      if (!term) {
        [term] = await tx.insert(periods).values({ companyId, yearId: year.id, startsOn: monthStart(date) < year.startsOn ? year.startsOn : monthStart(date),
          endsOn: monthEnd(date) > year.endsOn ? year.endsOn : monthEnd(date) }).returning();
        terms.push(term);
      }
      if (term.closed) { fatal("closed-period", `Accounting period ${term.startsOn} to ${term.endsOn} is closed.`, date, legacyCompany); continue; }
      periodFor.set(`${companyId}|${date}`, term.id);
    }
  }
  if (issues.some((i) => i.severity === "fatal")) return finish();

  /* New vouchers, posted as legacy vouchers with their original number, date, narration and lines. Creation times
     follow the full importer's synthetic ordering of the complete source so registers order same-day entries alike. */
  const ordered = [...data.vouchers].sort((a, b) => a.date.localeCompare(b.date) || compareIds(a.legacyId, b.legacyId));
  const created = (index: number) => new Date(Date.UTC(2000, 0, 1) + index * 1000 + 500);
  const voucherTarget = new Map<string, string>(old.vouchers.filter((v) => has("voucher", v.legacyId)).map((v) => [v.legacyId, target.get(`voucher|${v.legacyId}`)!]));
  const importable = newVouchers.filter((v) => !v.quarantine);
  for (const v of newVouchers.filter((v) => v.quarantine === "empty-voucher")) outcome.voucher = { ...outcome.voucher, skipped: (outcome.voucher?.skipped ?? 0) + 1 };
  for (const v of importable) {
    const companyId = companyOf(v.company);
    const [row] = await tx.insert(vouchers).values({ companyId, periodId: periodFor.get(`${companyId}|${v.date}`)!, date: v.date, type: v.type,
      narration: v.narration, createdBy: actor.id, createdAt: created(ordered.indexOf(v)) }).returning({ id: vouchers.id });
    voucherTarget.set(v.legacyId, row.id);
    await tx.insert(journalLines).values(v.lines.map((line) => ({
      companyId, voucherId: row.id, lineNo: line.lineNo, accountId: accountTarget.get(line.account)!.id,
      partyId: line.party ? partyTarget.get(line.party)! : null, itemId: line.item ? itemTarget.get(line.item) ?? null : null,
      debit: line.debit, credit: line.credit, description: line.description,
    })));
    await tx.execute(sql`UPDATE vouchers SET number=${v.number},status='posted',posted_at=now() WHERE id=${row.id}`);
    record(companyId, "voucher", v.legacyId, row.id, "imported");
  }

  /* Vouchers edited in the desktop application: revise the posted voucher through the application's revision path. */
  const accountName = (legacy: string) => data.accounts.find((a) => a.legacyId === legacy)?.name ?? legacy;
  for (const v of revised) {
    const companyId = companyOf(v.company);
    const before = oldVouchers.get(v.legacyId)!;
    const id = voucherTarget.get(v.legacyId)!;
    const entry = manualVoucher.parse({
      type: v.type, date: v.date, reference: "", narration: v.narration, mode: v.lines.some((l) => l.party) ? "party" : "direct",
      lines: v.lines.map((l) => ({ accountId: accountTarget.get(l.account)!.id, partyId: l.party ? partyTarget.get(l.party)! : null, itemId: null,
        description: l.description.slice(0, 250), debit: l.debit, credit: l.credit })),
    });
    // An earlier merge may already have revised it, so the document exists at a later version.
    const [document] = await tx.select({ version: voucherDocuments.version }).from(voucherDocuments).where(eq(voucherDocuments.id, id));
    try {
      await tx.transaction((savepoint) => saveManual(savepoint, { companyId, actorId: actor.id, require: () => undefined }, {
        entry, id, version: document?.version ?? 0, intent: "post", reason: `Edited in the desktop application after import; merged from backup ${sourceSha.slice(0, 12)}`,
      }));
    } catch (error) {
      if (!(error instanceof AccountingError)) throw error;
      fatal("revision-refused", `Voucher ${v.number} was edited in the desktop application but the revision is refused: ${error.message} ` +
        "Fix the cause in the web application (for example mark the account as cash or bank) and run the merge again.", v.legacyId, v.company);
      continue;
    }
    record(companyId, "voucher_revision", v.legacyId, id, "imported");
    report.revisions.push({ company: v.company, voucher: v.number, before: lineSummary(before, accountName), after: lineSummary(v, accountName) });
  }

  if (issues.some((i) => i.severity === "fatal")) return finish();

  /* Invoices: one header with lines, linked to the imported voucher. */
  for (const invoice of newInvoices) {
    const companyId = companyOf(invoice.company);
    const [header] = await tx.insert(invoices).values({
      companyId, number: invoice.number, type: invoice.type, date: invoice.date, partyId: partyTarget.get(invoice.party!)!,
      voucherId: voucherTarget.get(invoice.voucher)!, total: invoice.total, status: "posted", createdBy: actor.id,
      createdAt: created(ordered.findIndex((v) => v.legacyId === invoice.voucher)),
    }).returning({ id: invoices.id });
    await tx.insert(invoiceLines).values(invoice.lines.map((line, n) => ({
      companyId, invoiceId: header.id, itemId: itemTarget.get(line.item)!, lineNo: n + 1, qty: line.qty, rate: line.rate, amount: line.amount, subtotal: line.amount,
    })));
    record(companyId, "invoice", invoice.key, header.id, "imported");
    const voucher = data.vouchers.find((v) => v.legacyId === invoice.voucher)!;
    const sign = invoice.type === "sale" || invoice.type === "purchase_return" ? 1 : -1;
    const settled = voucher.lines.filter((l) => ["receivable", "payable", "cash", "bank"].includes(accountTarget.get(l.account)?.control ?? ""))
      .reduce((t, l) => t.plus(d(l.debit).minus(l.credit)), d(0)).times(sign);
    if (!settled.eq(invoice.total)) issues.push({ code: "invoice-total-differs", severity: "review", entity: "invoice", legacyId: invoice.key, company: invoice.company,
      message: `Invoice ${invoice.number} totals ${invoice.total} but voucher ${voucher.number} settles ${settled.toFixed(2)}.`,
      resolution: "Import both as recorded. The voucher remains the ledger record; review the invoice document." });
  }

  /* Stock movements for new invoice lines, continuing each item's moving average. A movement dated before an item's
     latest existing movement would change already-valued history, so it is fatal. */
  const moves = newInvoices.flatMap((invoice) => invoice.lines.map((line, n) => ({ invoice, line, n, order: ordered.findIndex((v) => v.legacyId === invoice.voucher) })))
    .sort((a, b) => a.invoice.date.localeCompare(b.invoice.date) || a.order - b.order || a.n - b.n);
  const [{ next }] = (await tx.execute<{ next: number }>(sql`SELECT coalesce(max(line_no),0)::int AS next FROM stock_movements WHERE company_id IN (${inCompanies})`)).rows;
  let lineNo = next;
  const positions = new Map<string, { qty: Decimal; value: Decimal; last: string }>();
  for (const { invoice, line } of moves) {
    const itemId = itemTarget.get(line.item)!;
    if (!positions.has(itemId)) {
      const [p] = (await tx.execute<{ qty: string; value: string; last: string | null }>(sql`SELECT coalesce(sum(signed_quantity),0)::text AS qty,
        coalesce(sum(signed_value),0)::text AS value, max(accounting_date)::text AS last FROM stock_movements WHERE item_id=${itemId}`)).rows;
      positions.set(itemId, { qty: d(p.qty), value: d(p.value), last: p.last ?? "" });
    }
    const position = positions.get(itemId)!;
    if (position.last > invoice.date) { fatal("backdated-stock", `Invoice ${invoice.number} moves stock before the item's latest recorded movement (${position.last}).`, invoice.key, invoice.company); continue; }
    const qty = d(line.qty).times(invoice.type === "sale" || invoice.type === "purchase_return" ? -1 : 1);
    let value: Decimal;
    if (invoice.type === "purchase") value = d(line.amount);
    else if (qty.lt(0)) value = (qty.negated().eq(position.qty) ? position.value : position.qty.lte(0) ? d(0) : position.value.div(position.qty).times(qty.negated()).toDecimalPlaces(2, Exact.ROUND_HALF_UP)).negated();
    else value = position.qty.gt(0) ? position.value.div(position.qty).times(qty).toDecimalPlaces(2, Exact.ROUND_HALF_UP) : d(0);
    position.qty = position.qty.plus(qty);
    position.value = position.value.plus(value);
    position.last = invoice.date;
    if (position.qty.lt(0)) issues.push({ code: "negative-stock", severity: "blocking", entity: "item", legacyId: line.item, company: invoice.company,
      message: `Invoice ${invoice.number} takes an item below zero on ${invoice.date}.`, resolution: "Import as recorded. Post an approved stock correction." });
    await tx.insert(stockMoves).values({ companyId: companyOf(invoice.company), itemId, voucherId: voucherTarget.get(invoice.voucher)!, date: invoice.date,
      qty: qty.toFixed(6), value: value.isZero() || value.isNegative() === qty.isNegative() ? value.toFixed(2) : "0.00",
      unitCost: qty.isZero() ? "0" : value.div(qty).abs().toFixed(10), movementKind: invoice.type, lineNo: ++lineNo });
  }
  if (issues.some((i) => i.severity === "fatal")) return finish();

  /* Advance document sequences beyond imported numbers, as the full importer does. */
  for (const companyId of ids) await advanceSequences(tx, companyId);
  for (const batch of chunk(records, 500)) await tx.insert(legacyImportRecords).values(batch);
  for (const companyId of ids) await tx.insert(auditLogs).values({ companyId, actorId: actor.id, action: "legacy.delta_imported", data: { baseSha256: baseSha, sourceSha256: sourceSha } });

  /* Verify the complete source against the complete target. */
  finish();
  report.verification = await verify(tx, data, companyTarget, accountTarget, partyTarget, []);
  for (const company of data.companies) {
    const [row] = (await tx.execute<{ stock: string; gl: string }>(sql`SELECT
      (SELECT coalesce(sum(signed_value),0) FROM stock_movements WHERE company_id=${companyOf(company.legacyId)})::text AS stock,
      (SELECT coalesce(sum(l.debit-l.credit),0) FROM effective_vouchers e JOIN journal_lines l ON l.company_id=e.company_id AND l.voucher_id=e.id
        JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id WHERE e.company_id=${companyOf(company.legacyId)} AND a.control='inventory')::text AS gl`)).rows;
    report.inventory.push({ company: company.legacyId, derivedStock: d(row.stock).toFixed(2), inventoryGl: d(row.gl).toFixed(2) });
    if (!d(row.stock).eq(row.gl)) issues.push({ code: "inventory-valuation-difference", severity: "review", entity: "company", legacyId: company.legacyId, company: company.legacyId,
      message: `Stock ledger value ${d(row.stock).toFixed(2)} differs from the Inventory account ${d(row.gl).toFixed(2)} after the merge.`,
      resolution: "Merge as recorded. The difference stays visible in Financial reconciliation until an approved valuation adjustment is posted." });
  }
  return finish();
}
