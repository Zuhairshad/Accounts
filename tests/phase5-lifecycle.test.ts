import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../src/db";
import * as schema from "../src/db/schema";
import { idempotently } from "../src/lib/accounting";
import { reconcile } from "../src/lib/audit/reconcile";
import { manualVoucher } from "../src/lib/engine/model";
import { partyBalances, readVoucher } from "../src/lib/engine/read";
import { allocatePayment, invoiceOutstanding, paymentSources } from "../src/lib/engine/settlement";
import { changeVoucher, saveManual } from "../src/lib/engine/vouchers";
import { invoiceSchema } from "../src/lib/trade/model";
import { inventorySummary, invoiceDetail } from "../src/lib/trade/read";
import { saveInvoice, tradeLifecycle } from "../src/lib/trade/service";
import { companyFixture, connect, day, end, testUrl } from "./support/fixture";

describe("input validation at the schema boundary", () => {
  const line = (debit: string, credit: string) => ({ accountId: randomUUID(), partyId: null, description: "", debit, credit });
  const voucher = (lines: ReturnType<typeof line>[], date = "2026-01-02") => ({ type: "JV", mode: "direct", date, reference: "", narration: "", lines });
  it.each([
    ["negative amount", voucher([line("-5", "0"), line("0", "5")])],
    ["three decimal places", voucher([line("1.005", "0"), line("0", "1.005")])],
    ["impossible date", voucher([line("5", "0"), line("0", "5")], "2026-02-30")],
    ["date outside the supported range", voucher([line("5", "0"), line("0", "5")], "1899-12-31")],
    ["amount beyond 18 integer digits", voucher([line("1000000000000000000", "0"), line("0", "1000000000000000000")])],
    ["non-numeric amount", voucher([line("1e3", "0"), line("0", "1e3")])],
  ])("rejects a voucher with a %s", (_label, input) => {
    expect(manualVoucher.safeParse(input).success).toBe(false);
  });
  it("rejects invoice lines with zero/negative quantity, excess precision or a missing item", () => {
    const base = { type: "sale", date: "2026-01-02", partyId: randomUUID(), dueOn: "", externalRef: "", poRef: "", narration: "", notes: "", reason: "",
      originalInvoiceId: null, exchangeReturnId: null, withholding: "0", duplicateReason: "", payments: [] };
    const item = { itemId: randomUUID(), description: "", quantity: "1", rate: "10", discount: "0", tax: "0", historicalCost: "0", originalLineNo: null, disposition: "saleable" };
    expect(invoiceSchema.safeParse({ ...base, lines: [item] }).success).toBe(true);
    for (const bad of [{ quantity: "-1" }, { quantity: "1.0000001" }, { rate: "-10" }, { rate: "1.00000000001" }, { itemId: "not-a-uuid" }]) {
      expect(invoiceSchema.safeParse({ ...base, lines: [{ ...item, ...bad }] }).success, JSON.stringify(bad)).toBe(false);
    }
    expect(invoiceSchema.safeParse({ ...base, lines: [] }).success).toBe(false);
  });
});

describe.skipIf(!testUrl)("phase 5 transaction lifecycle and edge cases", () => {
  let pool: Pool;
  let db: Database;
  beforeAll(() => { ({ pool, db } = connect()); });
  afterAll(async () => { await pool?.end(); });

  /** Every reconciliation check must pass, proving journal, stock, party and report consistency after the step. */
  async function reconciled(companyId: string, step: string, from = day(1), to = end) {
    const result = await db.transaction((tx) => reconcile(tx, companyId, { from, to }), { isolationLevel: "repeatable read", accessMode: "read only" });
    expect(result.checks.filter((c) => c.status !== "pass").map((c) => `${c.key}: ${c.summary} ${JSON.stringify(c.findings)}`), step).toEqual([]);
  }
  const stock = (companyId: string, item: string) => inventorySummary(db, companyId, end, item).then((rows) => rows[0]);
  const invoice = (companyId: string, id: string) => invoiceDetail(db, companyId, id).then((d) => d!.invoice);

  it("keeps every dependent balance reconciled across create, edit, void, restore and repeated restore", async () => {
    const f = await companyFixture(db, "Lifecycle");
    const purchase = await f.post(f.invoice("purchase", day(2), "10", "100"));
    await reconciled(f.companyId, "purchase posted");
    const draft = await f.post(f.invoice("sale", day(3), "2", "150"), undefined, 0, "draft");
    expect(await stock(f.companyId, f.item)).toMatchObject({ qty: "10.000000" });
    await reconciled(f.companyId, "sale drafted");
    let sale = await invoice(f.companyId, draft.id);
    await f.post(f.invoice("sale", day(3), "2", "150"), draft.id, sale.version);
    sale = await invoice(f.companyId, draft.id);
    const firstNumber = sale.number;
    await reconciled(f.companyId, "sale posted");
    await f.post(f.invoice("sale", day(3), "3", "150"), sale.id, sale.version);
    sale = await invoice(f.companyId, sale.id);
    expect(sale.number).toBe(firstNumber);
    expect(sale.total).toBe("450.00");
    expect(await stock(f.companyId, f.item)).toMatchObject({ qty: "7.000000", value: "700.00" });
    await reconciled(f.companyId, "posted sale revised");

    await f.lock((tx) => tradeLifecycle(tx, f.ctx, "invoice", sale.id, sale.version, "void", "Customer cancelled"));
    expect(await stock(f.companyId, f.item)).toMatchObject({ qty: "10.000000", value: "1000.00" });
    await reconciled(f.companyId, "sale voided");
    sale = await invoice(f.companyId, sale.id);
    await f.lock((tx) => tradeLifecycle(tx, f.ctx, "invoice", sale.id, sale.version, "restore", "Cancellation reversed"));
    expect(await stock(f.companyId, f.item)).toMatchObject({ qty: "7.000000" });
    await reconciled(f.companyId, "sale restored");
    await expect(f.lock((tx) => tradeLifecycle(tx, f.ctx, "invoice", sale.id, sale.version, "restore", "Stale repeated restore"))).rejects.toThrow(/changed|already/);
    sale = await invoice(f.companyId, sale.id);
    await expect(f.lock((tx) => tradeLifecycle(tx, f.ctx, "invoice", sale.id, sale.version, "restore", "Repeated restore"))).rejects.toThrow(/already/);
    await reconciled(f.companyId, "repeat restore refused");

    // A voided document keeps its number; later documents never receive it.
    await f.lock((tx) => tradeLifecycle(tx, f.ctx, "invoice", sale.id, sale.version, "void", "Void again"));
    const next = await f.post(f.invoice("sale", day(3), "1", "150"));
    const replacement = await invoice(f.companyId, next.id);
    expect(replacement.number).not.toBe(firstNumber);
    expect((await invoice(f.companyId, sale.id)).number).toBe(firstNumber);
    const numbers = await db.select({ n: schema.vouchers.number }).from(schema.vouchers).where(eq(schema.vouchers.companyId, f.companyId));
    expect(new Set(numbers.map((r) => r.n)).size).toBe(numbers.length);

    // A purchase that supports a later sale cannot be voided.
    const p = await invoice(f.companyId, purchase.id);
    await expect(f.lock((tx) => tradeLifecycle(tx, f.ctx, "invoice", p.id, p.version, "void", "Try removing supporting purchase"))).rejects.toThrow();
    await reconciled(f.companyId, "dependent purchase void refused");

    // Manual voucher lifecycle.
    const posted = await f.saveVoucher(f.voucher("CPV", day(4), [f.line("6000", "debit", "300"), f.line("cash", "credit", "300")]));
    let v = (await readVoucher(db, f.companyId, posted.id))!;
    await f.saveVoucher(f.voucher("CPV", day(4), [f.line("6000", "debit", "350"), f.line("cash", "credit", "350")]), "post", posted.id, v.version);
    v = (await readVoucher(db, f.companyId, posted.id))!;
    expect(v.number).toBe(posted.number);
    await reconciled(f.companyId, "voucher revised");
    await f.lock((tx) => changeVoucher(tx, f.ctx, { id: posted.id, version: v.version, operation: "delete", reason: "Entered twice" }));
    await reconciled(f.companyId, "voucher voided");
    const other = await f.saveVoucher(f.voucher("CPV", day(4), [f.line("6000", "debit", "50"), f.line("cash", "credit", "50")]));
    expect(other.number).not.toBe(posted.number);
    await f.lock((tx) => changeVoucher(tx, f.ctx, { id: posted.id, version: v.version + 1, operation: "restore", reason: "Not a duplicate" }));
    await expect(f.lock((tx) => changeVoucher(tx, f.ctx, { id: posted.id, version: v.version + 2, operation: "restore", reason: "Again" }))).rejects.toThrow();
    await reconciled(f.companyId, "voucher restored once");
  });

  it("refuses unauthorized, cross-company and closed-period changes without side effects", async () => {
    const a = await companyFixture(db, "Tenant A");
    const b = await companyFixture(db, "Tenant B");
    class Denied extends Error {}
    const viewer = { ...a.ctx, require: (permission: string) => { if (permission !== "view") throw new Denied(permission); } };
    await expect(a.lock((tx) => saveManual(tx, viewer, { entry: a.voucher("JV", day(2), [a.line("cash", "debit", "5"), a.line("4100", "credit", "5")]), intent: "post", version: 0, reason: "" })))
      .rejects.toBeInstanceOf(Denied);
    // Another company's account or party cannot be used, and another company's invoice cannot be read.
    await expect(a.saveVoucher(a.voucher("JV", day(2), [a.line(b.heads.cash, "debit", "5"), a.line("4100", "credit", "5")]))).rejects.toThrow();
    await expect(a.post({ ...a.invoice("sale", day(2), "1", "10"), partyId: b.customer.id })).rejects.toThrow();
    await b.post(b.invoice("purchase", day(2), "1", "10"));
    const [foreign] = await db.select().from(schema.invoices).where(eq(schema.invoices.companyId, b.companyId));
    expect(await invoiceDetail(db, a.companyId, foreign.id)).toBeNull();
    expect(await db.select().from(schema.vouchers).where(eq(schema.vouchers.companyId, a.companyId))).toHaveLength(0);

    // Closed period: posting, revision, void and restore are all refused until an approved reopening.
    const purchase = await a.post(a.invoice("purchase", day(2), "5", "10"));
    const posted = await a.saveVoucher(a.voucher("JV", day(3), [a.line("cash", "debit", "5"), a.line("4100", "credit", "5")]));
    await db.update(schema.periods).set({ closed: true }).where(eq(schema.periods.id, a.periods[0].id));
    const inv = await invoice(a.companyId, purchase.id);
    const v = (await readVoucher(db, a.companyId, posted.id))!;
    await expect(a.post(a.invoice("purchase", day(4), "1", "10"))).rejects.toThrow(/closed|period/i);
    await expect(a.lock((tx) => tradeLifecycle(tx, a.ctx, "invoice", inv.id, inv.version, "void", "Closed period void"))).rejects.toThrow(/closed|period/i);
    await expect(a.lock((tx) => changeVoucher(tx, a.ctx, { id: posted.id, version: v.version, operation: "delete", reason: "Closed period" }))).rejects.toThrow(/closed|period/i);
    await expect(a.saveVoucher(a.voucher("JV", day(3), [a.line("cash", "debit", "6"), a.line("4100", "credit", "6")]), "post", posted.id, v.version)).rejects.toThrow(/closed|period/i);
    await db.update(schema.periods).set({ closed: false }).where(eq(schema.periods.id, a.periods[0].id));
    await a.lock((tx) => tradeLifecycle(tx, a.ctx, "invoice", inv.id, inv.version, "void", "Reopened period void"));
    await reconciled(a.companyId, "after closed-period refusals");
    await reconciled(b.companyId, "other tenant untouched");
  });

  it("rolls back every row when a transaction fails after posting, and returns the stored result for a retried request", async () => {
    const f = await companyFixture(db, "Atomic");
    const count = async () => (await db.execute<{ v: string; i: string; s: string }>(sql`SELECT
      (SELECT count(*) FROM vouchers WHERE company_id=${f.companyId})::text AS v,
      (SELECT count(*) FROM invoices WHERE company_id=${f.companyId})::text AS i,
      (SELECT coalesce(sum(last_value),0) FROM document_sequences WHERE company_id=${f.companyId})::text AS s`)).rows[0];
    const before = await count();
    await expect(f.lock(async (tx) => {
      await saveInvoice(tx, f.ctx, { input: f.invoice("purchase", day(2), "3", "10"), version: 0, intent: "post", reason: "" });
      throw new Error("Simulated connection loss before commit");
    })).rejects.toThrow(/Simulated/);
    expect(await count()).toEqual(before);

    const key = randomUUID();
    const input = f.invoice("purchase", day(2), "3", "10");
    const requestHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const submit = () => f.lock((tx) => idempotently(tx, { companyId: f.companyId, operation: "trade.invoice", key, actorId: f.userId, requestHash },
      async () => saveInvoice(tx, f.ctx, { input, version: 0, intent: "post", reason: "" })));
    const first = await submit();
    const retry = await submit();
    expect(retry).toEqual(first);
    expect((await db.select().from(schema.invoices).where(eq(schema.invoices.companyId, f.companyId)))).toHaveLength(1);
    await expect(f.lock((tx) => idempotently(tx, { companyId: f.companyId, operation: "trade.invoice", key, actorId: f.userId, requestHash: "different" },
      async () => ({ id: "x" })))).rejects.toThrow(/cannot be reused/);
    await reconciled(f.companyId, "after rollback and retry");
  });

  it("allocates unique numbers to simultaneous invoices from several users", async () => {
    const f = await companyFixture(db, "Parallel");
    await f.post(f.invoice("purchase", day(2), "100", "10"));
    const results = await Promise.all(Array.from({ length: 6 }, () => f.post(f.invoice("sale", day(3), "1", "15"))));
    const numbers = await Promise.all(results.map((r) => invoice(f.companyId, r.id).then((i) => i.number)));
    expect(new Set(numbers).size).toBe(6);
    expect(await stock(f.companyId, f.item)).toMatchObject({ qty: "94.000000" });
    await reconciled(f.companyId, "parallel sales");
  });

  it("handles rounding, fractional quantities, identical lines, large values and refunds beyond credit", async () => {
    const f = await companyFixture(db, "Edges");
    await f.post(f.invoice("purchase", day(2), "10.5", "33.333333"));
    const sale = await f.post(f.invoice("sale", day(3), "3", "33.335"));
    expect((await invoice(f.companyId, sale.id)).total).toBe("100.01");
    // Two identical lines on one invoice are separate lines; returns track each original line.
    const twin = f.invoice("sale", day(4), "1", "50");
    twin.lines = [twin.lines[0], { ...twin.lines[0] }];
    const twins = await f.post(twin);
    const ret = f.invoice("sale_return", day(5), "1", "0", { originalInvoiceId: twins.id });
    ret.lines[0].originalLineNo = 2;
    await f.post(ret);
    const again = f.invoice("sale_return", day(5), "0.000001", "0", { originalInvoiceId: twins.id });
    again.lines[0].originalLineNo = 2;
    await expect(f.post(again)).rejects.toThrow(/exceed/);
    const refund = f.invoice("sale_return", day(5), "1", "0", { originalInvoiceId: twins.id, payments: [{ accountId: f.heads.cash, amount: "50.01" }] });
    refund.lines[0].originalLineNo = 1;
    await expect(f.post(refund)).rejects.toThrow(/cannot exceed/);
    // Large exact values.
    const big = "999999999999999999.99";
    await f.saveVoucher(f.voucher("JV", day(6), [f.line("1500", "debit", big), f.line("capital", "credit", big)]));
    await f.saveVoucher(f.voucher("JV", day(6), [f.line("1500", "debit", big), f.line("capital", "credit", big)]));
    const [fixed] = (await db.execute<{ total: string }>(sql`SELECT sum(l.debit)::text AS total FROM journal_lines l
      JOIN effective_vouchers e ON e.company_id=l.company_id AND e.id=l.voucher_id JOIN accounts a ON a.id=l.account_id
      WHERE l.company_id=${f.companyId} AND a.code='1500'`)).rows;
    expect(fixed.total).toBe("1999999999999999999.98");
    // A line value beyond the supported numeric range fails atomically.
    await expect(f.post(f.invoice("purchase", day(7), "999999999999999999", "999999999"))).rejects.toThrow();
    await reconciled(f.companyId, "rounding and edge values");
  });

  it("keeps advances, partial payments and overpayments visible and reconciled", async () => {
    const f = await companyFixture(db, "Settlement");
    await f.post(f.invoice("purchase", day(2), "10", "100"));
    const sale = await f.post(f.invoice("sale", day(3), "4", "150"));
    const receipt = await f.saveVoucher(f.voucher("CRV", day(4), [f.line("cash", "debit", "1000"), f.line("receivable", "credit", "1000", f.customer.id)], "party"));
    const [source] = await paymentSources(db, f.companyId, f.customer.id, day(4));
    expect(source).toBeTruthy();
    const partial = await f.lock((tx) => allocatePayment(tx, f.ctx, { partyId: f.customer.id, lineId: source.id, invoiceId: sale.id, amount: "200", date: day(4) }));
    expect(partial.remaining).toBe("0.00");
    expect((await invoiceOutstanding(db, f.companyId, day(4), f.customer.id))[0].outstanding).toBe("400.00");
    await expect(f.lock((tx) => allocatePayment(tx, f.ctx, { partyId: f.customer.id, lineId: source.id, invoiceId: sale.id, amount: "500", date: day(4) })))
      .rejects.toThrow(/open balance/);
    const fifo = await f.lock((tx) => allocatePayment(tx, f.ctx, { partyId: f.customer.id, lineId: source.id, amount: "800", date: day(4) }));
    expect(fifo.remaining).toBe("400.00");
    expect(receipt.number).toBeTruthy();
    const balance = (await partyBalances(db, f.companyId, end)).find((row) => row.id === f.customer.id);
    expect(balance?.balance).toBe("-400.00");
    // Supplier advance paid before any purchase invoice.
    await f.saveVoucher(f.voucher("CPV", day(5), [f.line("payable", "debit", "250", f.supplier.id), f.line("cash", "credit", "250")], "party"));
    await reconciled(f.companyId, "advances and allocations");
  });

  it("crosses a financial-year boundary and refuses postings into a closed year", async () => {
    const f = await companyFixture(db, "Year end");
    const [next] = await db.insert(schema.financialYears).values({ companyId: f.companyId, name: "2027", startsOn: "2027-01-01", endsOn: "2027-12-31" }).returning();
    await db.insert(schema.periods).values({ companyId: f.companyId, yearId: next.id, startsOn: "2027-01-01", endsOn: "2027-12-31" });
    await f.saveVoucher(f.voucher("CRV", end, [f.line("cash", "debit", "100"), f.line("4100", "credit", "100")]));
    const jan = await f.saveVoucher(f.voucher("CRV", "2027-01-01", [f.line("cash", "debit", "40"), f.line("4100", "credit", "40")]));
    expect(jan.number).toMatch(/20270101/);
    await db.update(schema.financialYears).set({ closed: true }).where(and(eq(schema.financialYears.companyId, f.companyId), eq(schema.financialYears.id, f.yearId)));
    await expect(f.saveVoucher(f.voucher("JV", "2026-06-01", [f.line("cash", "debit", "1"), f.line("4100", "credit", "1")]))).rejects.toThrow(/closed|period|year/i);
    await f.saveVoucher(f.voucher("JV", "2027-02-01", [f.line("cash", "debit", "1"), f.line("4100", "credit", "1")]));
    await reconciled(f.companyId, "new year", "2027-01-01", "2027-12-31");
  });
});
