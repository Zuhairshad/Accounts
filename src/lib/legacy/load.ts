import { and, eq, sql } from "drizzle-orm";
import type { Database, Transaction } from "@/db";
import {
  accounts, auditLogs, companies, documentSequences, financialYears, invoiceLines, invoices, items, journalLines,
  legacyImportRecords, legacyImports, operationHistory, parties, periods, stockMoves, units, users, vouchers,
} from "@/db/schema";
import { insertCompany } from "@/db/seed";
import { reconcile } from "@/lib/audit/reconcile";
import { Exact } from "@/lib/engine/model";
import { legacyNumber, normalize, type Dataset, type Issue, type LegacyVoucher } from "./normalize";
import { sha256, type LegacySource, type Mapping } from "./source";

type Decimal = InstanceType<typeof Exact>;
const d = (value: string | number | Decimal) => new Exact(value.toString());

export type Approval = {
  approvedBy: string; role: string; approvedAt: string; reportSha256: string;
  /** Issue code -> count. Must equal the blocking and review counts of the approved dry-run report exactly. */
  accepted: Record<string, number>; notes: string;
};
export type Difference = { scope: string; key: string; source: string; target: string; explained: string; unexplained: string };
export type Report = {
  source: { sha256: string; bytes: number; signature: string; counts: Record<string, number> };
  mappingSha256: string; profile: string;
  issues: { code: string; severity: Issue["severity"]; count: number; resolution: string }[];
  details: Issue[];
  companies: { legacyId: string; legacyName: string; target: string; created: boolean }[];
  outcome: Record<string, Record<string, number>>;
  verification: { differences: Difference[]; unexplained: number; reconciliation: Record<string, { key: string; status: string; summary: string }[]> };
  inventory: { company: string; derivedStock: string; inventoryGl: string }[];
  manualReconciliation: { company: string; voucher: string; line: number; amount: string; reason: string }[];
};
export type Result = { status: "fatal" | "dry-run" | "committed" | "refused"; report: Report; reportSha256: string; reasons: string[]; importId?: string };

class Abort extends Error { constructor(readonly result: Result) { super(result.status); } }

/** Report hash covers everything an approver reviews and excludes generated IDs and timestamps. */
export function reportHash(report: Report) {
  const content = JSON.stringify({ ...report, companies: report.companies.map(({ legacyId, legacyName, created }) => ({ legacyId, legacyName, created })) });
  return sha256(content.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>"));
}

const chunk = <T,>(rows: T[], size = 400) => Array.from({ length: Math.ceil(rows.length / size) }, (_, i) => rows.slice(i * size, i * size + size));
const monthStart = (date: string) => `${date.slice(0, 7)}-01`;
function monthEnd(date: string) {
  const [y, m] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
function fiscalYear(date: string, startMonth: number) {
  const [y, m] = date.split("-").map(Number);
  const start = m >= startMonth ? y : y - 1;
  const startsOn = `${start}-${String(startMonth).padStart(2, "0")}-01`;
  const next = new Date(Date.UTC(startMonth === 1 ? start + 1 : start + 1, startMonth - 1, 1));
  const endsOn = new Date(next.getTime() - 86_400_000).toISOString().slice(0, 10);
  return { startsOn, endsOn, name: startMonth === 1 ? `FY ${start}` : `FY ${start}-${String(start + 1).slice(2)}` };
}

export async function runLegacyImport(db: Database, source: LegacySource, mapping: Mapping, mappingSha256: string,
  options: { mode: "dry-run" | "import"; actor: string; approval?: Approval }): Promise<Result> {
  const { schema, problems } = source.validate(mapping);
  const data: Dataset = problems.length ? { companies: [], accounts: [], parties: [], items: [], vouchers: [], invoices: [], orphanLines: [], issues: [], sourceCounts: {} }
    : normalize(mapping, (entity) => source.read(mapping, entity));
  for (const problem of problems) data.issues.push({ code: "mapping-mismatch", severity: "fatal", entity: "mapping", legacyId: problem, message: problem, resolution: "Correct the mapping file to match the inspected schema." });

  try {
    return await db.transaction(async (tx) => {
      const report = await plan(tx, data, mapping, options.actor, source.sha256);
      report.source = { sha256: source.sha256, bytes: source.bytes, signature: schema.signature, counts: data.sourceCounts };
      report.mappingSha256 = mappingSha256;
      report.profile = mapping.profile;
      const hash = () => reportHash(report);
      const fatal = report.issues.filter((i) => i.severity === "fatal");
      if (fatal.length) throw new Abort({ status: "fatal", report, reportSha256: hash(), reasons: fatal.map((i) => `${i.code} (${i.count})`) });
      if (report.verification.unexplained) {
        throw new Abort({ status: "fatal", report, reportSha256: hash(), reasons: [`${report.verification.unexplained} unexplained source/target differences`] });
      }
      const reportSha256 = hash();
      if (options.mode === "dry-run") {
        throw new Abort({ status: "dry-run", report, reportSha256, reasons: ["Dry run: every change was rolled back."] });
      }
      const reasons = approvalProblems(options.approval, report, reportSha256);
      if (reasons.length) throw new Abort({ status: "refused", report, reportSha256, reasons });
      const [record] = await tx.insert(legacyImports).values({
        sourceSha256: source.sha256, mappingSha256, reportSha256, approvedBy: options.approval!.approvedBy,
        approval: options.approval!, summary: { outcome: report.outcome, companies: report.companies, verification: report.verification },
      }).returning();
      await tx.execute(sql`UPDATE legacy_import_records SET import_id=${record.id} WHERE import_id=${PENDING}`);
      await tx.execute(sql`DELETE FROM legacy_imports WHERE id=${PENDING}`);
      await tx.insert(operationHistory).values({ kind: "legacy_import", reference: record.id, status: "committed",
        details: { sourceSha256: source.sha256, reportSha256, approvedBy: options.approval!.approvedBy } });
      return { status: "committed" as const, report, reportSha256, reasons: [], importId: record.id };
    }, { isolationLevel: "serializable" });
  } catch (error) {
    if (error instanceof Abort) return error.result;
    throw error;
  }
}

/** Placeholder import row so record rows can be written before approval is checked; replaced on commit. */
const PENDING = "00000000-0000-4000-8000-000000000000";

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

async function plan(tx: Transaction, data: Dataset, mapping: Mapping, actorName: string, sourceSha: string): Promise<Report> {
  const issues = data.issues;
  const fatal = (code: string, message: string, legacyId = "", company?: string) =>
    issues.push({ code, severity: "fatal", entity: "plan", legacyId, company, message, resolution: "Resolve before importing; this cannot be approved." });
  const outcome: Report["outcome"] = {};
  const count = (entity: string, result: string) => { outcome[entity] ??= {}; outcome[entity][result] = (outcome[entity][result] ?? 0) + 1; };
  const records: (typeof legacyImportRecords.$inferInsert)[] = [];
  const record = (companyId: string | null, entity: string, legacyId: string, targetId: string | null, result: "imported" | "reused" | "quarantined" | "skipped", issue?: string, sourceRow?: unknown) => {
    count(entity, result);
    records.push({ importId: PENDING, companyId, entity, legacyId, targetId, outcome: result, issue, source: sourceRow ?? null });
  };
  const empty: Report = {
    source: { sha256: sourceSha, bytes: 0, signature: "", counts: {} }, mappingSha256: "", profile: "", issues: [], details: [], companies: [], outcome,
    verification: { differences: [], unexplained: 0, reconciliation: {} }, inventory: [], manualReconciliation: [],
  };
  const finish = (report: Report) => {
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

  // Placeholder import row satisfies the record foreign key inside this transaction.
  await tx.insert(legacyImports).values({ id: PENDING, sourceSha256: `pending:${sourceSha}`, mappingSha256: "", reportSha256: "", approvedBy: "pending", approval: {}, summary: {} });

  const [actor] = await tx.select().from(users).where(eq(users.username, actorName));
  if (!actor?.active || !actor.superAdmin) fatal("actor-not-authorized", `Operator "${actorName}" must be an active Super Admin.`);
  const [previous] = await tx.select().from(legacyImports).where(and(eq(legacyImports.sourceSha256, sourceSha), eq(legacyImports.status, "committed")));
  if (previous) fatal("already-imported", `This exact source database was already imported (${previous.id}, ${previous.createdAt.toISOString()}).`);
  if (issues.some((i) => i.severity === "fatal") || !actor) return finish(empty);

  /* Target companies: an existing target must be empty so live books are never merged with or overwritten by an import. */
  const companyTarget = new Map<string, string>();
  for (const company of data.companies) {
    const explicit = mapping.companyTargets[company.legacyId];
    const [existing] = explicit && "companyId" in explicit
      ? await tx.select().from(companies).where(eq(companies.id, explicit.companyId))
      : await tx.select().from(companies).where(sql`lower(${companies.name})=lower(${company.targetName})`);
    if (explicit && "companyId" in explicit && !existing) { fatal("target-company-missing", `Mapped target company ${explicit.companyId} does not exist.`, company.legacyId); continue; }
    if (existing) {
      await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, existing.id)).for("update");
      const [usage] = (await tx.execute<{ used: boolean }>(sql`SELECT
        EXISTS(SELECT 1 FROM vouchers WHERE company_id=${existing.id}) OR EXISTS(SELECT 1 FROM voucher_documents WHERE company_id=${existing.id})
        OR EXISTS(SELECT 1 FROM invoices WHERE company_id=${existing.id}) OR EXISTS(SELECT 1 FROM parties WHERE company_id=${existing.id})
        OR EXISTS(SELECT 1 FROM inventory_items WHERE company_id=${existing.id}) AS used`)).rows;
      if (usage.used) { fatal("target-not-empty", `Target company "${existing.name}" already has records. Import only into an empty company.`, company.legacyId); continue; }
      if (!existing.active) { fatal("target-inactive", `Target company "${existing.name}" is inactive.`, company.legacyId); continue; }
      companyTarget.set(company.legacyId, existing.id);
      empty.companies.push({ legacyId: company.legacyId, legacyName: company.name, target: existing.name, created: false });
      record(existing.id, "company", company.legacyId, existing.id, "reused");
    } else {
      const created = await insertCompany(tx, company.targetName);
      companyTarget.set(company.legacyId, created.id);
      empty.companies.push({ legacyId: company.legacyId, legacyName: company.name, target: company.targetName, created: true });
      record(created.id, "company", company.legacyId, created.id, "imported");
    }
  }
  if (issues.some((i) => i.severity === "fatal")) return finish(empty);
  const target = (legacy: string) => companyTarget.get(legacy)!;

  /* Accounts map by code onto the seeded chart, which shares the original nineteen legacy codes. */
  const accountTarget = new Map<string, { id: string; control: string | null }>();
  const createdAccounts = new Set<string>();
  const reusedAccounts = new Set<string>();
  for (const account of data.accounts) {
    const companyId = target(account.company);
    const [byCode] = await tx.select().from(accounts).where(and(eq(accounts.companyId, companyId), eq(accounts.code, account.code)));
    if (byCode && createdAccounts.has(byCode.id)) { fatal("duplicate-account-code", `Legacy accounts share code ${account.code} in one company; they would be merged.`, account.legacyId, account.company); continue; }
    if (byCode) {
      if (byCode.type !== account.type) { fatal("account-type-conflict", `Legacy account ${account.code} ${account.name} is ${account.type}; target ${byCode.code} is ${byCode.type}.`, account.legacyId, account.company); continue; }
      if (reusedAccounts.has(byCode.id)) { fatal("duplicate-account-code", `Legacy accounts share code ${account.code} in one company; they would be merged.`, account.legacyId, account.company); continue; }
      reusedAccounts.add(byCode.id);
      accountTarget.set(account.legacyId, { id: byCode.id, control: byCode.control });
      record(companyId, "account", account.legacyId, byCode.id, "reused");
      continue;
    }
    const [byName] = await tx.select().from(accounts).where(and(eq(accounts.companyId, companyId), sql`lower(${accounts.name})=lower(${account.name})`));
    if (byName) { fatal("account-name-conflict", `Legacy account ${account.code} "${account.name}" matches target account ${byName.code} by name only.`, account.legacyId, account.company); continue; }
    const [created] = await tx.insert(accounts).values({ companyId, code: account.code, name: account.name, type: account.type }).returning();
    createdAccounts.add(created.id);
    accountTarget.set(account.legacyId, { id: created.id, control: null });
    record(companyId, "account", account.legacyId, created.id, "imported");
  }
  if (issues.some((i) => i.severity === "fatal")) return finish(empty);

  /* Parties */
  const partyTarget = new Map<string, string>();
  for (const batch of chunk(data.parties)) {
    const rows = await tx.insert(parties).values(batch.map((p) => ({ companyId: target(p.company), name: p.importName, type: p.type, phone: p.phone, address: p.address })))
      .returning({ id: parties.id });
    batch.forEach((p, i) => { partyTarget.set(p.legacyId, rows[i].id); record(target(p.company), "party", p.legacyId, rows[i].id, "imported"); });
  }
  const partyById = new Map(data.parties.map((p) => [p.legacyId, p]));

  /* Party links: a party is valid only on its matching control account. Others need an approved unlink. */
  const manual: Report["manualReconciliation"] = [];
  for (const voucher of data.vouchers) {
    if (voucher.quarantine) continue;
    for (const line of voucher.lines) {
      const control = accountTarget.get(line.account)?.control;
      const party = line.party ? partyById.get(line.party) : undefined;
      const fits = party && ((party.type === "customer" && control === "receivable") || (party.type === "supplier" && control === "payable"));
      if (party && !fits) {
        issues.push({ code: "party-control-mismatch", severity: "blocking", entity: "voucher", legacyId: voucher.legacyId, company: voucher.company,
          message: `${voucher.number} line ${line.lineNo}: ${party.type} "${party.name}" is tagged on an account that is not the ${party.type === "customer" ? "receivable" : "payable"} control.`,
          resolution: "Import the amount unchanged without the party tag; the party name is kept in the line description." });
        line.unlinkedParty = party.name;
        line.description = `${line.description} [legacy party: ${party.name}]`.trim().slice(0, 1000);
        line.party = null;
      }
      if (!line.party && (control === "receivable" || control === "payable")) {
        manual.push({ company: voucher.company, voucher: voucher.number, line: line.lineNo, amount: d(line.debit).minus(line.credit).toFixed(2),
          reason: line.unlinkedParty ? "Party tag removed (wrong party type)" : "Control line without a customer or supplier" });
      }
    }
  }
  if (manual.length) {
    for (const entry of manual) issues.push({ code: "unlinked-control-line", severity: "review", entity: "voucher", legacyId: `${entry.voucher}#${entry.line}`,
      company: entry.company, message: `${entry.voucher} line ${entry.line} (${entry.amount}) is on a control account without a party.`,
      resolution: "Import as recorded. Link it to the correct party through Legacy party voucher linking after review." });
  }

  /* Accounting calendar covering every imported date. */
  const periodFor = new Map<string, string>();
  const dates = new Map<string, Set<string>>();
  const want = (company: string, date: string) => { if (date) dates.set(company, (dates.get(company) ?? new Set()).add(date)); };
  data.vouchers.filter((v) => !v.quarantine).forEach((v) => want(v.company, v.date));
  data.invoices.filter((i) => !i.quarantine).forEach((i) => want(i.company, i.date));
  for (const [legacyCompany, set] of dates) {
    const companyId = target(legacyCompany);
    const years = await tx.select().from(financialYears).where(eq(financialYears.companyId, companyId));
    const terms = await tx.select().from(periods).where(eq(periods.companyId, companyId));
    for (const date of [...set].sort()) {
      if (periodFor.has(`${companyId}|${date}`)) continue;
      let year = years.find((y) => y.startsOn <= date && y.endsOn >= date);
      if (!year) {
        const fy = fiscalYear(date, mapping.fiscalYearStartMonth);
        [year] = await tx.insert(financialYears).values({ companyId, ...fy }).returning();
        years.push(year);
      }
      if (year.closed) { fatal("closed-year", `Financial year ${year.name} is closed but ${date} must be imported into it.`, date, legacyCompany); continue; }
      let term = terms.find((p) => p.startsOn <= date && p.endsOn >= date);
      if (!term) {
        const startsOn = monthStart(date) < year.startsOn ? year.startsOn : monthStart(date);
        const endsOn = monthEnd(date) > year.endsOn ? year.endsOn : monthEnd(date);
        [term] = await tx.insert(periods).values({ companyId, yearId: year.id, startsOn, endsOn }).returning();
        terms.push(term);
      }
      if (term.closed) { fatal("closed-period", `Accounting period ${term.startsOn} to ${term.endsOn} is closed.`, date, legacyCompany); continue; }
      for (const day of set) if (day >= term.startsOn && day <= term.endsOn) periodFor.set(`${companyId}|${day}`, term.id);
    }
  }
  if (issues.some((i) => i.severity === "fatal")) return finish(empty);

  /* Units and items */
  const itemTarget = new Map<string, string>();
  for (const legacyCompany of new Set(data.items.map((i) => i.company))) {
    const companyId = target(legacyCompany);
    const names = [...new Set(data.items.filter((i) => i.company === legacyCompany).map((i) => i.unit))];
    const unitRows = await tx.insert(units).values(names.map((name) => ({ companyId, name }))).returning();
    const unitId = new Map(unitRows.map((u) => [u.name, u.id]));
    const list = data.items.filter((i) => i.company === legacyCompany);
    const seenNames = new Set<string>();
    for (const batch of chunk(list)) {
      const rows = await tx.insert(items).values(batch.map((i) => {
        let name = i.name;
        if (seenNames.has(name.toLowerCase())) {
          name = `${i.name} (legacy ${i.legacyId})`;
          issues.push({ code: "duplicate-item-name", severity: "blocking", entity: "item", legacyId: i.legacyId, company: legacyCompany,
            message: `Item "${i.name}" appears more than once.`, resolution: `Import as "${name}" without merging stock.` });
        }
        seenNames.add(name.toLowerCase());
        return { companyId, unitId: unitId.get(i.unit)!, name, kind: "stock" };
      })).returning({ id: items.id });
      batch.forEach((i, n) => { itemTarget.set(i.legacyId, rows[n].id); record(companyId, "item", i.legacyId, rows[n].id, "imported"); });
    }
  }

  /* Vouchers keep their legacy number, date, narration and lines. They are posted as legacy (unmanaged) vouchers, so the
     existing adoption, repair and reporting paths apply; no journal entry is regenerated. */
  const voucherTarget = new Map<string, string>();
  const ordered = [...data.vouchers].sort((a, b) => a.date.localeCompare(b.date) || compareIds(a.legacyId, b.legacyId));
  const base = Date.UTC(2000, 0, 1);
  const created = (index: number) => new Date(base + index * 1000);
  const importable = ordered.filter((v) => !v.quarantine);
  for (const v of ordered.filter((v) => v.quarantine)) {
    record(target(v.company), "voucher", v.legacyId, null, v.quarantine === "empty-voucher" ? "skipped" : "quarantined", v.quarantine, v);
  }
  for (const batch of chunk(importable, 300)) {
    const rows = await tx.insert(vouchers).values(batch.map((v) => ({
      companyId: target(v.company), periodId: periodFor.get(`${target(v.company)}|${v.date}`)!, date: v.date, type: v.type,
      narration: v.narration, createdBy: actor.id, createdAt: created(ordered.indexOf(v)),
    }))).returning({ id: vouchers.id });
    batch.forEach((v, i) => voucherTarget.set(v.legacyId, rows[i].id));
    const lines = batch.flatMap((v) => v.lines.map((line) => ({
      companyId: target(v.company), voucherId: voucherTarget.get(v.legacyId)!, lineNo: line.lineNo,
      accountId: accountTarget.get(line.account)!.id, partyId: line.party ? partyTarget.get(line.party)! : null,
      debit: line.debit, credit: line.credit, description: line.description,
    })));
    for (const part of chunk(lines, 500)) await tx.insert(journalLines).values(part);
  }

  /* Stock openings: link to an equivalent legacy posting when one exists; otherwise an approved opening voucher is needed. */
  const openingVoucherFor = new Map<string, string>();
  const createdOpenings: { company: string; value: Decimal; legacyId: string }[] = [];
  for (const item of data.items) {
    const qty = d(item.openingQty);
    if (qty.isZero()) continue;
    const value = qty.times(item.openingRate).toDecimalPlaces(2, Exact.ROUND_HALF_UP);
    const companyDates = [...(dates.get(item.company) ?? [])].sort();
    const date = item.openingDate ?? companyDates[0] ?? "";
    if (!date) { issues.push({ code: "stock-opening-undated", severity: "blocking", entity: "item", legacyId: item.legacyId, company: item.company,
      message: `Opening stock for "${item.name}" has no date and the company has no dated activity.`, resolution: "Import the item without opening stock." }); continue; }
    if (value.isZero()) { issues.push({ code: "stock-opening-zero-value", severity: "blocking", entity: "item", legacyId: item.legacyId, company: item.company,
      message: `Opening quantity ${item.openingQty} for "${item.name}" has no value.`, resolution: "Import the item without opening stock; enter an approved opening adjustment." }); continue; }
    const inventoryAccounts = new Set([...accountTarget.entries()].filter(([, a]) => a.control === "inventory").map(([legacy]) => legacy));
    const equivalent = importable.find((v) => v.company === item.company && v.date <= date &&
      v.lines.some((l) => inventoryAccounts.has(l.account) && d(l.debit).eq(value)) &&
      (v.type === "opening" || v.narration.toLowerCase().includes(item.name.toLowerCase())));
    if (equivalent) {
      openingVoucherFor.set(item.legacyId, voucherTarget.get(equivalent.legacyId)!);
      issues.push({ code: "stock-opening-linked", severity: "info", entity: "item", legacyId: item.legacyId, company: item.company,
        message: `Opening stock for "${item.name}" (${value.toFixed(2)}) matches legacy voucher ${equivalent.number}.`, resolution: "Attach the stock opening to that voucher; no journal is created." });
      continue;
    }
    issues.push({ code: "stock-opening-unposted", severity: "blocking", entity: "item", legacyId: item.legacyId, company: item.company,
      message: `Opening stock for "${item.name}" (${item.openingQty} × ${item.openingRate} = ${value.toFixed(2)}) has no matching legacy journal posting.`,
      resolution: "Post an opening voucher: Dr Inventory / Cr Opening Balance Equity for the opening value on the opening date." });
    const companyId = target(item.company);
    const [inv] = await tx.select().from(accounts).where(and(eq(accounts.companyId, companyId), eq(accounts.control, "inventory")));
    const [equity] = await tx.select().from(accounts).where(and(eq(accounts.companyId, companyId), eq(accounts.control, "opening_equity")));
    let periodId = periodFor.get(`${companyId}|${date}`);
    if (!periodId) {
      const [term] = (await tx.execute<{ id: string }>(sql`SELECT id FROM accounting_periods WHERE company_id=${companyId} AND starts_on<=${date}::date AND ends_on>=${date}::date`)).rows;
      if (!term) { fatal("stock-opening-period", `No accounting period covers the stock opening date ${date}.`, item.legacyId, item.company); continue; }
      periodId = term.id;
    }
    const [voucher] = await tx.insert(vouchers).values({ companyId, periodId, date, type: "opening", narration: `Legacy opening stock: ${item.name}`,
      createdBy: actor.id, createdAt: created(-1) }).returning();
    await tx.insert(journalLines).values([
      { companyId, voucherId: voucher.id, lineNo: 1, accountId: inv.id, itemId: itemTarget.get(item.legacyId)!, debit: value.toFixed(2), credit: "0", description: `Opening stock ${item.name}` },
      { companyId, voucherId: voucher.id, lineNo: 2, accountId: equity.id, debit: "0", credit: value.toFixed(2), description: `Opening stock ${item.name}` },
    ]);
    voucherTarget.set(`stock-opening:${item.legacyId}`, voucher.id);
    openingVoucherFor.set(item.legacyId, voucher.id);
    createdOpenings.push({ company: item.company, value, legacyId: item.legacyId });
  }

  /* Number vouchers and post them. Numbers are preserved; a created stock opening receives an explicit legacy number. */
  const numberRows = [
    ...importable.map((v) => ({ id: voucherTarget.get(v.legacyId)!, number: v.number })),
    ...createdOpenings.map((o) => ({ id: voucherTarget.get(`stock-opening:${o.legacyId}`)!, number: `LEGACY-STOCK-OPEN-${o.legacyId}` })),
  ];
  for (const batch of chunk(numberRows, 500)) {
    await tx.execute(sql`UPDATE vouchers v SET number=x.number,status='posted',posted_at=now()
      FROM (VALUES ${sql.join(batch.map((r) => sql`(${r.id}::uuid,${r.number})`), sql`,`)}) AS x(id,number) WHERE v.id=x.id`);
  }
  importable.forEach((v) => record(target(v.company), "voucher", v.legacyId, voucherTarget.get(v.legacyId)!, "imported"));
  createdOpenings.forEach((o) => record(target(o.company), "stock_opening_voucher", o.legacyId, voucherTarget.get(`stock-opening:${o.legacyId}`)!, "imported"));

  /* Invoices become one header with lines; the existing legacy voucher remains the financial record. */
  const invoiceTarget = new Map<string, string>();
  for (const invoice of data.invoices) {
    const companyId = target(invoice.company);
    if (invoice.quarantine) { record(companyId, "invoice", invoice.key, null, "quarantined", invoice.quarantine, invoice.rows); continue; }
    const [header] = await tx.insert(invoices).values({
      companyId, number: invoice.number, type: invoice.type, date: invoice.date, partyId: partyTarget.get(invoice.party!)!,
      voucherId: voucherTarget.get(invoice.voucher)!, total: invoice.total, status: "posted", createdBy: actor.id,
      createdAt: created(ordered.findIndex((v) => v.legacyId === invoice.voucher)),
    }).returning({ id: invoices.id });
    invoiceTarget.set(invoice.key, header.id);
    await tx.insert(invoiceLines).values(invoice.lines.map((line, n) => ({
      companyId, invoiceId: header.id, itemId: itemTarget.get(line.item)!, lineNo: n + 1, qty: line.qty, rate: line.rate,
      amount: line.amount, subtotal: line.amount,
    })));
    record(companyId, "invoice", invoice.key, header.id, "imported");
    // Settlement side of the legacy voucher should equal the invoice total.
    const voucher = data.vouchers.find((v) => v.legacyId === invoice.voucher)!;
    const sign = invoice.type === "sale" || invoice.type === "purchase_return" ? 1 : -1;
    const settled = voucher.lines.filter((l) => ["receivable", "payable", "cash", "bank"].includes(accountTarget.get(l.account)?.control ?? ""))
      .reduce((t, l) => t.plus(d(l.debit).minus(l.credit)), d(0)).times(sign);
    if (!settled.eq(invoice.total)) issues.push({ code: "invoice-total-differs", severity: "review", entity: "invoice", legacyId: invoice.key, company: invoice.company,
      message: `Invoice ${invoice.number} totals ${invoice.total} but voucher ${voucher.number} settles ${settled.toFixed(2)}.`,
      resolution: "Import both as recorded. The voucher remains the ledger record; review the invoice document." });
  }

  /* Stock movements, replayed chronologically at moving average, linked to the source voucher. */
  const derived = new Map<string, Decimal>();
  type Move = { company: string; item: string; date: string; qty: Decimal; kind: string; voucher: string; order: number; legacy: string };
  const moves: Move[] = [];
  for (const item of data.items) {
    const voucher = openingVoucherFor.get(item.legacyId);
    const date = item.openingDate ?? [...(dates.get(item.company) ?? [])].sort()[0];
    if (voucher && date) moves.push({ company: item.company, item: item.legacyId, date, qty: d(item.openingQty), kind: "opening", voucher, order: -1, legacy: item.legacyId });
  }
  for (const invoice of data.invoices.filter((i) => !i.quarantine)) {
    const order = ordered.findIndex((v) => v.legacyId === invoice.voucher);
    invoice.lines.forEach((line, n) => moves.push({ company: invoice.company, item: line.item, date: invoice.date,
      qty: d(line.qty).times(invoice.type === "sale" || invoice.type === "purchase_return" ? -1 : 1), kind: invoice.type,
      voucher: voucherTarget.get(invoice.voucher)!, order: order * 1000 + n, legacy: `${invoice.key}#${n + 1}` }));
  }
  moves.sort((a, b) => a.date.localeCompare(b.date) || (a.kind === "opening" ? -1 : 0) - (b.kind === "opening" ? -1 : 0) || a.order - b.order);
  const positions = new Map<string, { qty: Decimal; value: Decimal }>();
  const amountFor = new Map<string, string>(data.invoices.flatMap((i) => i.lines.map((l, n): [string, string] => [`${i.key}#${n + 1}`, l.amount])));
  const rateFor = new Map(data.items.map((i) => [i.legacyId, i.openingRate]));
  const negative = new Set<string>();
  const stockRows: (typeof stockMoves.$inferInsert)[] = [];
  for (const move of moves) {
    const position = positions.get(move.item) ?? { qty: d(0), value: d(0) };
    let value: Decimal;
    if (move.kind === "opening") value = move.qty.times(rateFor.get(move.item)!).toDecimalPlaces(2, Exact.ROUND_HALF_UP);
    else if (move.kind === "purchase") value = d(amountFor.get(move.legacy)!);
    else if (move.qty.lt(0)) {
      const out = move.qty.negated();
      value = (out.eq(position.qty) ? position.value : position.qty.lte(0) ? d(0) : position.value.div(position.qty).times(out).toDecimalPlaces(2, Exact.ROUND_HALF_UP)).negated();
    } else value = position.qty.gt(0) ? position.value.div(position.qty).times(move.qty).toDecimalPlaces(2, Exact.ROUND_HALF_UP) : d(0);
    position.qty = position.qty.plus(move.qty);
    position.value = position.value.plus(value);
    positions.set(move.item, position);
    if (position.qty.lt(0) && !negative.has(move.item)) {
      negative.add(move.item);
      issues.push({ code: "negative-stock", severity: "blocking", entity: "item", legacyId: move.item, company: move.company,
        message: `Legacy activity takes "${data.items.find((i) => i.legacyId === move.item)?.name}" below zero on ${move.date} (backdated or missing purchase).`,
        resolution: "Import movements as recorded. Post an approved stock correction before new transactions for this item." });
    }
    derived.set(move.company, (derived.get(move.company) ?? d(0)).plus(value));
    const qty = move.qty;
    stockRows.push({ companyId: target(move.company), itemId: itemTarget.get(move.item)!, voucherId: move.voucher, date: move.date,
      qty: qty.toFixed(6), value: value.isZero() || value.isNegative() === qty.isNegative() ? value.toFixed(2) : "0.00",
      unitCost: qty.isZero() ? "0" : value.div(qty).abs().toFixed(10), movementKind: move.kind, lineNo: stockRows.length + 1 });
  }
  for (const batch of chunk(stockRows, 500)) await tx.insert(stockMoves).values(batch);

  /* Advance document sequences beyond imported numbers in the new numbering format. */
  for (const companyId of new Set(companyTarget.values())) {
    await tx.execute(sql`
      INSERT INTO document_sequences(company_id,year_id,kind,last_value)
      SELECT v.company_id,p.year_id,v.type::text,max((regexp_match(v.number,'^(?:[A-Za-z0-9]+-)?[A-Za-z_]+-\\d{8}-(\\d{1,9})$'))[1]::int)
      FROM vouchers v JOIN accounting_periods p ON p.company_id=v.company_id AND p.id=v.period_id
      WHERE v.company_id=${companyId} AND v.number ~ '^(?:[A-Za-z0-9]+-)?[A-Za-z_]+-\\d{8}-\\d{1,9}$'
      GROUP BY v.company_id,p.year_id,v.type
      ON CONFLICT (company_id,year_id,kind) DO UPDATE SET last_value=greatest(${documentSequences.lastValue},excluded.last_value)`);
  }
  for (const batch of chunk(records, 500)) await tx.insert(legacyImportRecords).values(batch);
  for (const companyId of new Set(companyTarget.values())) {
    await tx.insert(auditLogs).values({ companyId, actorId: actor.id, action: "legacy.imported", data: { sourceSha256: sourceSha } });
  }

  const report = finish(empty);
  report.manualReconciliation = manual;
  report.verification = await verify(tx, data, companyTarget, accountTarget, partyTarget, createdOpenings);
  report.inventory = data.companies.map((c) => ({ company: c.legacyId, derivedStock: (derived.get(c.legacyId) ?? d(0)).toFixed(2), inventoryGl: "0.00" }));
  for (const row of report.inventory) {
    const [gl] = (await tx.execute<{ value: string }>(sql`SELECT coalesce(sum(l.debit-l.credit),0)::text AS value FROM effective_vouchers e
      JOIN journal_lines l ON l.company_id=e.company_id AND l.voucher_id=e.id JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id
      WHERE e.company_id=${target(row.company)} AND a.control='inventory'`)).rows;
    row.inventoryGl = d(gl.value).toFixed(2);
    if (!d(row.inventoryGl).eq(row.derivedStock)) issues.push({ code: "inventory-valuation-difference", severity: "review", entity: "company", legacyId: row.company,
      company: row.company, message: `Derived moving-average stock value ${row.derivedStock} differs from the imported Inventory ledger ${row.inventoryGl}.`,
      resolution: "Import as recorded. The difference stays visible in Financial reconciliation until an approved valuation adjustment is posted." });
  }
  return finish(report);
}

const compareIds = (a: string, b: string) => (/^\d+$/.test(a) && /^\d+$/.test(b) ? Number(a) - Number(b) : a.localeCompare(b));

async function verify(tx: Transaction, data: Dataset, companyTarget: Map<string, string>, accountTarget: Map<string, { id: string }>,
  partyTarget: Map<string, string>, openings: { company: string; value: Decimal }[]): Promise<Report["verification"]> {
  const differences: Difference[] = [];
  const add = (scope: string, key: string, source: Decimal, target: Decimal, explained: Decimal) => {
    const unexplained = target.minus(source).minus(explained);
    if (!target.eq(source) || !unexplained.isZero()) differences.push({ scope, key, source: source.toFixed(2), target: target.toFixed(2),
      explained: explained.toFixed(2), unexplained: unexplained.toFixed(2) });
  };
  const effect = (vs: LegacyVoucher[], pick: (l: LegacyVoucher["lines"][number]) => string | null) => {
    const totals = new Map<string, Decimal>();
    for (const v of vs) for (const l of v.lines) { const k = pick(l); if (k) totals.set(k, (totals.get(k) ?? d(0)).plus(d(l.debit).minus(l.credit))); }
    return totals;
  };
  const valid = data.vouchers.filter((v) => v.quarantine !== "unknown-account" && v.quarantine !== "invalid-amount");
  const quarantined = valid.filter((v) => v.quarantine);

  // Trial balance by account: source (all readable vouchers) vs target; quarantined vouchers and created openings explain differences.
  const sourceTb = effect(valid, (l) => l.account);
  const removed = effect(quarantined, (l) => l.account);
  const ids = [...companyTarget.values()];
  const targetTb = new Map((await tx.execute<{ account: string; net: string }>(sql`SELECT l.account_id AS account,sum(l.debit-l.credit)::text AS net
    FROM effective_vouchers e JOIN journal_lines l ON l.company_id=e.company_id AND l.voucher_id=e.id
    WHERE e.company_id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`,`)}) GROUP BY l.account_id`)).rows.map((r) => [r.account, d(r.net)]));
  const openingByCompany = new Map<string, Decimal>();
  for (const o of openings) openingByCompany.set(o.company, (openingByCompany.get(o.company) ?? d(0)).plus(o.value));
  const accountsById = new Map(data.accounts.map((a) => [a.legacyId, a]));
  const seenTargets = new Set<string>();
  for (const [legacy, { id }] of accountTarget) {
    seenTargets.add(id);
    const account = accountsById.get(legacy)!;
    const controls = (await tx.select({ control: accounts.control }).from(accounts).where(eq(accounts.id, id)))[0]?.control;
    const createdOpening = openingByCompany.get(account.company) ?? d(0);
    const explained = (removed.get(legacy) ?? d(0)).negated().plus(controls === "inventory" ? createdOpening : controls === "opening_equity" ? createdOpening.negated() : 0);
    add("trial-balance", `${account.company}:${account.code} ${account.name}`, sourceTb.get(legacy) ?? d(0), targetTb.get(id) ?? d(0), explained);
  }
  // Seeded accounts with no legacy counterpart receive only created stock openings.
  for (const companyId of ids) {
    const legacyCompany = [...companyTarget.entries()].find(([, t]) => t === companyId)![0];
    for (const control of ["inventory", "opening_equity"] as const) {
      const [row] = await tx.select().from(accounts).where(and(eq(accounts.companyId, companyId), eq(accounts.control, control)));
      if (!row || seenTargets.has(row.id)) continue;
      const value = openingByCompany.get(legacyCompany) ?? d(0);
      add("trial-balance", `${legacyCompany}:${row.code} ${row.name} (seeded)`, d(0), targetTb.get(row.id) ?? d(0), control === "inventory" ? value : value.negated());
    }
  }

  // Party balances: unlinked tags and quarantined vouchers explain differences.
  const sourceParty = new Map<string, Decimal>();
  const explainedParty = new Map<string, Decimal>();
  const nameToId = new Map(data.parties.map((p) => [`${p.company}|${p.name}`, p.legacyId]));
  for (const v of valid) for (const l of v.lines) {
    const party = l.party ?? (l.unlinkedParty ? nameToId.get(`${v.company}|${l.unlinkedParty}`) ?? null : null);
    if (!party) continue;
    const amount = d(l.debit).minus(l.credit);
    sourceParty.set(party, (sourceParty.get(party) ?? d(0)).plus(amount));
    if (v.quarantine || l.unlinkedParty) explainedParty.set(party, (explainedParty.get(party) ?? d(0)).minus(amount));
  }
  const targetParty = new Map((await tx.execute<{ party: string; net: string }>(sql`SELECT l.party_id AS party,sum(l.debit-l.credit)::text AS net
    FROM effective_vouchers e JOIN journal_lines l ON l.company_id=e.company_id AND l.voucher_id=e.id
    WHERE e.company_id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`,`)}) AND l.party_id IS NOT NULL GROUP BY l.party_id`)).rows.map((r) => [r.party, d(r.net)]));
  for (const party of data.parties) {
    add("party-balance", `${party.company}:${party.type}:${party.importName}`, sourceParty.get(party.legacyId) ?? d(0),
      targetParty.get(partyTarget.get(party.legacyId)!) ?? d(0), explainedParty.get(party.legacyId) ?? d(0));
  }

  // Invoice totals by company and type.
  for (const [legacyCompany, companyId] of companyTarget) {
    for (const type of ["sale", "purchase", "sale_return", "purchase_return"] as const) {
      const group = data.invoices.filter((i) => i.company === legacyCompany && i.type === type);
      const rowsTotal = (i: (typeof group)[number]) => i.rows.reduce((s, r) => s.plus(legacyNumber(r.amount, 2)?.value ?? 0), d(0));
      const source = group.reduce((t, i) => t.plus(rowsTotal(i)), d(0));
      const removedTotal = group.filter((i) => i.quarantine).reduce((t, i) => t.plus(rowsTotal(i)), d(0));
      const [row] = (await tx.execute<{ total: string }>(sql`SELECT coalesce(sum(total),0)::text AS total FROM invoices WHERE company_id=${companyId} AND type=${type} AND status='posted'`)).rows;
      add("invoice-total", `${legacyCompany}:${type}`, source, d(row.total), removedTotal.negated());
    }
    // Record counts.
    const [counts] = (await tx.execute<{ vouchers: string; invoices: string; parties: string; items: string }>(sql`SELECT
      (SELECT count(*) FROM vouchers WHERE company_id=${companyId} AND status='posted')::text AS vouchers,
      (SELECT count(*) FROM invoices WHERE company_id=${companyId})::text AS invoices,
      (SELECT count(*) FROM parties WHERE company_id=${companyId})::text AS parties,
      (SELECT count(*) FROM inventory_items WHERE company_id=${companyId})::text AS items`)).rows;
    const vs = data.vouchers.filter((v) => v.company === legacyCompany);
    add("count", `${legacyCompany}:vouchers`, d(vs.length), d(counts.vouchers),
      d(-vs.filter((v) => v.quarantine).length + openings.filter((o) => o.company === legacyCompany).length));
    const is = data.invoices.filter((i) => i.company === legacyCompany);
    add("count", `${legacyCompany}:invoices`, d(is.length), d(counts.invoices), d(-is.filter((i) => i.quarantine).length));
    add("count", `${legacyCompany}:parties`, d(data.parties.filter((p) => p.company === legacyCompany).length), d(counts.parties), d(0));
    add("count", `${legacyCompany}:items`, d(data.items.filter((i) => i.company === legacyCompany).length), d(counts.items), d(0));
  }

  // Run the application's own reconciliation over each imported company.
  const reconciliation: Report["verification"]["reconciliation"] = {};
  for (const [legacyCompany, companyId] of companyTarget) {
    const result = await reconcile(tx, companyId, { from: "1900-01-01", to: "2199-12-31" });
    reconciliation[legacyCompany] = result.checks.map((c) => ({ key: c.key, status: c.status, summary: c.summary }));
  }
  return { differences, unexplained: differences.filter((x) => !d(x.unexplained).isZero()).length, reconciliation };
}

/**
 * Post-commit withdrawal. Posted journals are immutable by design, so a committed import cannot be deleted. Withdrawal
 * deactivates the companies the import created and marks the import withdrawn; reused companies must be handled with a
 * Neon point-in-time restore of an isolated branch (see LEGACY_MIGRATION.md).
 */
export async function withdrawImport(db: Database, importId: string, actorName: string, reason: string) {
  if (reason.trim().length < 10) throw new Error("Enter a withdrawal reason of at least ten characters.");
  return db.transaction(async (tx) => {
    const [actor] = await tx.select().from(users).where(eq(users.username, actorName));
    if (!actor?.active || !actor.superAdmin) throw new Error("Withdrawal requires an active Super Admin.");
    const [entry] = await tx.select().from(legacyImports).where(eq(legacyImports.id, importId)).for("update");
    if (!entry || entry.status !== "committed") throw new Error("Only a committed import can be withdrawn.");
    const created = await tx.select().from(legacyImportRecords).where(and(eq(legacyImportRecords.importId, importId),
      eq(legacyImportRecords.entity, "company"), eq(legacyImportRecords.outcome, "imported")));
    const reused = await tx.select().from(legacyImportRecords).where(and(eq(legacyImportRecords.importId, importId),
      eq(legacyImportRecords.entity, "company"), eq(legacyImportRecords.outcome, "reused")));
    for (const row of created) {
      await tx.update(companies).set({ active: false, version: sql`${companies.version}+1` }).where(eq(companies.id, row.targetId!));
      await tx.insert(auditLogs).values({ companyId: row.targetId, actorId: actor.id, action: "legacy.withdrawn", data: { importId, reason } });
    }
    await tx.update(legacyImports).set({ status: "withdrawn", withdrawnAt: new Date(), withdrawReason: reason }).where(eq(legacyImports.id, importId));
    await tx.insert(operationHistory).values({ kind: "legacy_import", reference: importId, status: "withdrawn", details: { reason, deactivated: created.length, reused: reused.length } });
    return { deactivated: created.map((r) => r.targetId!), reusedNeedRestore: reused.map((r) => r.targetId!) };
  });
}
