import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../src/db";
import * as schema from "../src/db/schema";
import { normalize, legacyDate, legacyNumber } from "../src/lib/legacy/normalize";
import { runLegacyImport, withdrawImport, type Approval, type Result } from "../src/lib/legacy/load";
import { LegacySource, mappingSchema, type Mapping } from "../src/lib/legacy/source";
import { saveInvoice } from "../src/lib/trade/service";
import { connect, testUrl } from "./support/fixture";
import { buildLegacySqlite } from "./support/legacy-sqlite";

const template = mappingSchema.parse(JSON.parse(readFileSync("scripts/legacy/mapping.example.json", "utf8")));

describe("legacy value parsing", () => {
  it("accepts the four desktop date formats and rejects impossible dates", () => {
    expect(["01-07-2025", "01/07/2025", "2025-07-01", "2025/07/01"].map(legacyDate)).toEqual(Array(4).fill("2025-07-01"));
    expect(legacyDate("31-02-2025")).toBeNull();
    expect(legacyDate("2025-13-01")).toBeNull();
    expect(legacyDate("")).toBeNull();
  });
  it("rounds REAL noise silently but reports true sub-paisa amounts", () => {
    expect(legacyNumber(0.1 + 0.2, 2)).toMatchObject({ exact: true });
    expect(legacyNumber(0.1 + 0.2, 2)?.value.toFixed(2)).toBe("0.30");
    expect(legacyNumber(10.005, 2)).toMatchObject({ exact: false });
    expect(legacyNumber("abc", 2)).toBeNull();
    expect(legacyNumber("1,250.50", 2)?.value.toFixed(2)).toBe("1250.50");
  });
  it("resolves original company aliases", () => {
    const data = normalize(template, (e) => e === "companies" ? [{ id: 1, name: "azam traders" }] : []);
    expect(data.companies[0].targetName).toBe("SAKOON / KHAWAB");
  });
});

describe.skipIf(!testUrl)("legacy SQLite migration on PostgreSQL", () => {
  let pool: Pool;
  let db: Database;
  let dir: string;
  let actor: string;
  beforeAll(async () => {
    ({ pool, db } = connect());
    dir = mkdtempSync(join(tmpdir(), "azam-legacy-"));
    actor = `migrator-${randomUUID().slice(0, 8)}`;
    await db.insert(schema.users).values({ username: actor, displayName: "Migration operator", passwordHash: "test-only", superAdmin: true });
  });
  afterAll(async () => { await pool?.end(); rmSync(dir, { recursive: true, force: true }); });

  function prepare(variant: "clean" | "anomalies") {
    const token = randomUUID();
    const path = join(dir, `${variant}-${token}.db`);
    buildLegacySqlite(path, variant, token);
    const mapping: Mapping = { ...template, companyTargets: variant === "anomalies" ? { "1": { name: `Anomaly import ${token}` } } : {} };
    return { path, token, mapping, sha: `mapping-${variant}` };
  }
  const execute = (p: ReturnType<typeof prepare>, mode: "dry-run" | "import", approval?: Approval) => {
    const source = LegacySource.open(p.path);
    return runLegacyImport(db, source, p.mapping, p.sha, { mode, actor, approval }).finally(() => source.close());
  };
  const approve = (result: Result, overrides: Partial<Approval> = {}): Approval => ({
    approvedBy: "Chief Accountant", role: "ICAP member", approvedAt: "2026-11-26", notes: "Reviewed every issue against paper records.",
    reportSha256: result.reportSha256,
    accepted: Object.fromEntries(result.report.issues.filter((i) => ["blocking", "review"].includes(i.severity)).map((i) => [i.code, i.count])),
    ...overrides,
  });
  const companyFor = async (name: string) => (await db.select().from(schema.companies).where(sql`lower(${schema.companies.name})=lower(${name})`))[0];

  it("inspects the source read-only and never writes to it", () => {
    const p = prepare("clean");
    const before = readFileSync(p.path);
    const source = LegacySource.open(p.path);
    const schemaReport = source.schema();
    expect(schemaReport.tables.find((t) => t.name === "invoices")?.rows).toBe(3);
    expect(() => source.db.exec("DELETE FROM companies")).toThrow();
    expect(source.validate(template).problems).toEqual([]);
    expect(source.validate({ ...template, tables: { ...template.tables, vouchers: { ...template.tables.vouchers, columns: { ...template.tables.vouchers.columns, number: "missing_col" } } } }).problems)
      .toEqual(['vouchers.number: column "vouchers.missing_col" does not exist']);
    source.close();
    expect(readFileSync(p.path).equals(before)).toBe(true);
    writeFileSync(join(dir, "not-sqlite.db"), "plain text");
    expect(() => LegacySource.open(join(dir, "not-sqlite.db"))).toThrow(/not a SQLite/);
  });

  it("dry-runs without leaving data, imports a clean ledger exactly, refuses repeats and keeps working afterwards", async () => {
    const p = prepare("clean");
    const dry = await execute(p, "dry-run");
    expect(dry.status, JSON.stringify(dry.reasons)).toBe("dry-run");
    expect(dry.report.issues.filter((i) => i.severity !== "info")).toEqual([]);
    expect(dry.report.verification.unexplained).toBe(0);
    expect(await companyFor(`Legacy Clean Co ${p.token}`)).toBeUndefined();

    const committed = await execute(p, "import", approve(dry));
    expect(committed.status, JSON.stringify(committed.reasons)).toBe("committed");
    expect(committed.reportSha256).toBe(dry.reportSha256);
    const company = await companyFor(`Legacy Clean Co ${p.token}`);
    const docs = await db.select().from(schema.vouchers).where(eq(schema.vouchers.companyId, company.id));
    expect(docs.map((v) => v.number).sort()).toEqual(["CRV-1", "JV-1", "PUR-1", "SAL-1"]);
    const [sale] = await db.select().from(schema.invoices).where(and(eq(schema.invoices.companyId, company.id), eq(schema.invoices.number, "S-1")));
    expect(sale.total).toBe("600.00");
    expect(await db.select().from(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, sale.id))).toHaveLength(2);
    const recon = committed.report.verification.reconciliation["1"];
    expect(recon.filter((c) => c.status === "fail")).toEqual([]);
    expect(committed.report.inventory[0]).toMatchObject({ derivedStock: "600.00", inventoryGl: "600.00" });
    const [history] = await db.select().from(schema.operationHistory).where(eq(schema.operationHistory.reference, committed.importId!));
    expect(history.status).toBe("committed");

    const again = await execute(p, "dry-run");
    expect(again.status).toBe("fatal");
    expect(again.report.issues.map((i) => i.code)).toContain("already-imported");

    // The imported company accepts new managed postings that replay over imported legacy stock.
    const [user] = await db.select().from(schema.users).where(eq(schema.users.username, actor));
    const [customer] = await db.select().from(schema.parties).where(and(eq(schema.parties.companyId, company.id), eq(schema.parties.type, "customer")));
    const [item] = await db.select().from(schema.items).where(and(eq(schema.items.companyId, company.id), eq(schema.items.name, "Cloth roll")));
    await db.transaction(async (tx) => {
      await tx.execute(sql`select id from companies where id=${company.id} for update`);
      await saveInvoice(tx, { companyId: company.id, actorId: user.id, require: () => undefined }, { intent: "post", version: 0, reason: "New sale after migration",
        input: { type: "sale", date: "2025-07-20", partyId: customer.id, dueOn: "", externalRef: "", poRef: "", narration: "", notes: "", reason: "",
          originalInvoiceId: null, exchangeReturnId: null, withholding: "0", duplicateReason: "", payments: [],
          lines: [{ itemId: item.id, description: "", quantity: "2", rate: "160", discount: "0", tax: "0", historicalCost: "0", originalLineNo: null, disposition: "saleable" }] } });
    });
    const [stock] = (await db.execute<{ qty: string; value: string }>(sql`SELECT sum(signed_quantity)::text AS qty,sum(signed_value)::text AS value
      FROM stock_movements m JOIN effective_vouchers e ON e.company_id=m.company_id AND e.id=m.voucher_id WHERE m.item_id=${item.id}`)).rows;
    expect(stock).toEqual({ qty: "4.000000", value: "400.00" });
  });

  it("presents anomalies, refuses unapproved imports, applies only approved resolutions and can withdraw", async () => {
    const p = prepare("anomalies");
    const dry = await execute(p, "dry-run");
    expect(dry.status, JSON.stringify(dry.reasons)).toBe("dry-run");
    const codes = Object.fromEntries(dry.report.issues.map((i) => [i.code, [i.severity, i.count]]));
    expect(codes).toMatchObject({
      "duplicate-voucher-number": ["blocking", 1], "unbalanced-voucher": ["blocking", 1], "invalid-date": ["blocking", 1],
      "orphan-line": ["blocking", 1], "party-control-mismatch": ["blocking", 1], "duplicate-party-name": ["blocking", 1],
      "inconsistent-invoice-rows": ["blocking", 1], "stock-opening-unposted": ["blocking", 1], "negative-stock": ["blocking", 1],
      "unlinked-control-line": ["review", 1],
    });
    expect(dry.report.verification.unexplained).toBe(0);
    expect(dry.report.manualReconciliation).toEqual([{ company: "1", voucher: "JV-8", line: 1, amount: "250.00", reason: "Control line without a customer or supplier" }]);
    expect(await companyFor(`Anomaly import ${p.token}`)).toBeUndefined();

    expect((await execute(p, "import")).status).toBe("refused");
    const partial = approve(dry);
    delete partial.accepted["negative-stock"];
    const refused = await execute(p, "import", partial);
    expect(refused.status).toBe("refused");
    expect(refused.reasons).toContain("Approval must accept 1 × negative-stock.");
    expect((await execute(p, "import", approve(dry, { reportSha256: "0".repeat(64) }))).reasons[0]).toMatch(/exact dry-run report/);
    expect(await companyFor(`Anomaly import ${p.token}`)).toBeUndefined();

    const done = await execute(p, "import", approve(dry));
    expect(done.status, JSON.stringify(done.reasons)).toBe("committed");
    const company = await companyFor(`Anomaly import ${p.token}`);
    const numbers = (await db.select().from(schema.vouchers).where(eq(schema.vouchers.companyId, company.id))).map((v) => v.number).sort();
    expect(numbers).toContain("JV-1-DUP5");
    expect(numbers).toContain("LEGACY-STOCK-OPEN-2");
    expect(numbers).not.toContain("JV-6");
    const quarantined = await db.select().from(schema.legacyImportRecords).where(and(eq(schema.legacyImportRecords.importId, done.importId!),
      eq(schema.legacyImportRecords.outcome, "quarantined")));
    expect(quarantined.map((r) => r.issue).sort()).toEqual(["inconsistent-invoice-rows", "invalid-date", "unbalanced-voucher"]);
    expect(quarantined.every((r) => r.source !== null)).toBe(true);
    const names = (await db.select().from(schema.parties).where(eq(schema.parties.companyId, company.id))).map((r) => r.name).sort();
    expect(names).toEqual(["Ali Traders", "Ali Traders (legacy 3)", "Bilal Mills"]);
    // The freight line keeps its amount without the supplier tag.
    const [freight] = (await db.execute<{ description: string; party: string | null }>(sql`SELECT l.description,l.party_id AS party FROM journal_lines l
      JOIN vouchers v ON v.id=l.voucher_id WHERE v.company_id=${company.id} AND v.number='JV-9' AND l.debit=30`)).rows;
    expect(freight).toEqual({ description: "freight [legacy party: Bilal Mills]", party: null });

    const withdrawn = await withdrawImport(db, done.importId!, actor, "Accountant rejected the reconciliation");
    expect(withdrawn.deactivated).toEqual([company.id]);
    expect((await companyFor(`Anomaly import ${p.token}`)).active).toBe(false);
    await expect(withdrawImport(db, done.importId!, actor, "Second withdrawal attempt")).rejects.toThrow(/Only a committed/);
  });

  it("refuses to import into a company that already has records", async () => {
    const p = prepare("clean");
    const [busy] = await db.select().from(schema.companies).innerJoin(schema.parties, eq(schema.parties.companyId, schema.companies.id)).limit(1);
    p.mapping.companyTargets = { "1": { companyId: busy.companies.id } };
    const result = await execute(p, "dry-run");
    expect(result.status).toBe("fatal");
    expect(result.report.issues.map((i) => i.code)).toContain("target-not-empty");
  });
});
