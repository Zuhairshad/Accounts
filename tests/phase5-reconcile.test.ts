import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { Database } from "../src/db";
import * as schema from "../src/db/schema";
import { reconcile } from "../src/lib/audit/reconcile";
import { saveOpening } from "../src/lib/engine/masters";
import { openPeriod } from "../src/lib/engine/posting";
import { saveAdjustment, tradeLifecycle } from "../src/lib/trade/service";
import { companyFixture, connect, day, end, testUrl } from "./support/fixture";

describe.skipIf(!testUrl)("phase 5 financial reconciliation", () => {
  let pool: Pool;
  let db: Database;
  beforeAll(() => { ({ pool, db } = connect()); });
  afterAll(async () => { await pool?.end(); });
  const run = (companyId: string, from = day(1), to = end) => db.transaction((tx) => reconcile(tx, companyId, { from, to }),
    { isolationLevel: "repeatable read", accessMode: "read only" });
  const byKey = (result: Awaited<ReturnType<typeof run>>) => Object.fromEntries(result.checks.map((c) => [c.key, c]));

  it("reconciles a full trading cycle, including openings, payments, returns, adjustments, void and restore", async () => {
    const f = await companyFixture(db);
    await f.lock(async (tx) => {
      await saveOpening(tx, f.ctx, { kind: "party", targetId: f.customer.id, direction: "debit", amount: "1000", date: day(1), version: 0, reason: "Approved opening" });
      await saveOpening(tx, f.ctx, { kind: "party", targetId: f.supplier.id, direction: "credit", amount: "2500", date: day(1), version: 0, reason: "Approved opening" });
      await saveAdjustment(tx, f.ctx, { itemId: f.item, kind: "opening", date: day(1), quantity: "5", physical: "0", rate: "900",
        valueChange: "0", reference: "OPEN", reason: "Approved stock opening" });
    });
    const purchase = await f.post(f.invoice("purchase", day(2), "10", "1000", { payments: [{ accountId: f.heads.cash, amount: "2000" }] }));
    const sale = await f.post(f.invoice("sale", day(3), "4.5", "1500.333", { payments: [{ accountId: f.heads.bank, amount: "100" }] }));
    const ret = f.invoice("sale_return", day(4), "1", "0", { originalInvoiceId: sale.id });
    ret.lines[0].originalLineNo = 1;
    await f.post(ret);
    const damaged = f.invoice("sale_return", day(5), "0.5", "0", { originalInvoiceId: sale.id });
    damaged.lines[0] = { ...damaged.lines[0], originalLineNo: 1, disposition: "damaged" };
    await f.post(damaged);
    const supplierReturn = f.invoice("purchase_return", day(6), "2", "0", { originalInvoiceId: purchase.id });
    supplierReturn.lines[0].originalLineNo = 1;
    const purchaseReturn = await f.post(supplierReturn);
    await f.saveVoucher(f.voucher("CRV", day(7), [f.line("cash", "debit", "500"), f.line("receivable", "credit", "500", f.customer.id)], "party"));
    await f.lock((tx) => saveAdjustment(tx, f.ctx, { itemId: f.item, kind: "count", date: day(8), quantity: "0", physical: "9",
      rate: "0", valueChange: "0", reference: "COUNT", reason: "Approved physical count" }));
    const [record] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, purchaseReturn.id));
    await f.lock((tx) => tradeLifecycle(tx, f.ctx, "invoice", record.id, record.version, "void", "Phase 5 void check"));
    await f.lock((tx) => tradeLifecycle(tx, f.ctx, "invoice", record.id, record.version + 1, "restore", "Phase 5 restore check"));

    const result = await run(f.companyId);
    const failing = result.checks.filter((c) => c.status !== "pass");
    expect(failing.map((c) => ({ key: c.key, summary: c.summary, findings: c.findings }))).toEqual([]);
    const checks = byKey(result);
    expect(checks["receivable-subledger"].actual).toBe(checks["receivable-subledger"].expected);
    expect(checks.inventory.actual).not.toBe("0.00");
    expect(result.checks).toHaveLength(14);
  });

  it("reports an empty company as reconciled without inventing balances", async () => {
    const f = await companyFixture(db, "Empty");
    const result = await run(f.companyId);
    expect(result.checks.every((c) => c.status === "pass")).toBe(true);
    expect(byKey(result)["trial-balance"]).toMatchObject({ expected: "0.00", actual: "0.00" });
  });

  it("detects real discrepancies and links each affected record without changing data", async () => {
    const f = await companyFixture(db, "Discrepancy");
    await f.post(f.invoice("purchase", day(2), "10", "100"));
    // A legitimate but unattributed manual entry to the Inventory control account.
    const jv = await f.saveVoucher(f.voucher("JV", day(3), [f.line("inventory", "debit", "75"), f.line("cash", "credit", "75")]));
    // A legacy-style posting: receivable without a customer, crediting Sales outside any invoice.
    const legacy = randomUUID();
    await f.lock(async (tx) => {
      const period = await openPeriod(tx, f.companyId, day(4));
      await tx.insert(schema.vouchers).values({ id: legacy, companyId: f.companyId, periodId: period.id, date: day(4), type: "JV", createdBy: f.userId });
      await tx.insert(schema.journalLines).values([
        { ...f.line("receivable", "debit", "300"), companyId: f.companyId, voucherId: legacy, lineNo: 1 },
        { ...f.line("sales", "credit", "300"), companyId: f.companyId, voucherId: legacy, lineNo: 2 },
      ]);
      await tx.update(schema.vouchers).set({ status: "posted", number: "LEGACY-0001", postedAt: new Date() }).where(eq(schema.vouchers.id, legacy));
    });
    const before = await db.select().from(schema.journalLines).where(eq(schema.journalLines.companyId, f.companyId));

    const checks = byKey(await run(f.companyId));
    expect(checks.inventory).toMatchObject({ status: "fail", expected: "1075.00", actual: "1000.00", difference: "-75.00" });
    expect(checks.inventory.findings[0]).toMatchObject({ label: "Inventory lines without an item", amount: "-75.00" });
    expect(checks["receivable-subledger"]).toMatchObject({ status: "fail", expected: "300.00", actual: "0.00" });
    expect(checks["receivable-subledger"].findings[0]).toMatchObject({ label: `LEGACY-0001 · ${day(4)}`, amount: "300.00",
      href: `/workspace/${f.companyId}/accounting/vouchers/${legacy}` });
    expect(checks["net-sales"]).toMatchObject({ status: "fail", expected: "0.00", actual: "300.00" });
    expect(checks["net-sales"].findings[0].label).toBe("LEGACY-0001");
    for (const key of ["balanced-vouchers", "trial-balance", "balance-sheet", "profit-loss", "mis", "invoice-journal", "single-posting"]) {
      expect(checks[key].status, key).toBe("pass");
    }
    expect(jv.number).toBeTruthy();
    // Reconciliation is read-only.
    expect(await db.select().from(schema.journalLines).where(eq(schema.journalLines.companyId, f.companyId))).toEqual(before);
  });
});
