import { and, eq, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../src/db";
import { reconcile } from "../src/lib/audit/reconcile";
import * as schema from "../src/db/schema";
import { Exact } from "../src/lib/engine/model";
import { readLedger } from "../src/lib/engine/read";
import { saveSalesExecutive } from "../src/lib/engine/masters";
import { latestSaleExecutives, recordReceipt } from "../src/lib/engine/receipts";
import { companyWise } from "../src/lib/reports/financial";
import { buildReport, filters } from "../src/lib/reports/build";
import { movements } from "../src/lib/reports/journal";
import { executiveRows, type ExecutiveActivity } from "../src/lib/reports/sales";
import type { ReportDocument, ReportFilter } from "../src/lib/reports/model";
import type { InvoiceCalculation, InvoiceInput } from "../src/lib/trade/model";
import { invoiceDetail } from "../src/lib/trade/read";
import { saveItem } from "../src/lib/trade/service";
import { companyFixture, connect, day, end, testUrl } from "./support/fixture";

const range = (query: Record<string, string> = {}) => filters({ from: day(1), to: end, ...query }, "manual");
const values = (doc: ReportDocument, key: string) => doc.rows.find((row) => row.key === key)?.cells.map((cell) => cell.value);

describe.skipIf(!testUrl)("invoice line types, sales executives and receipts on PostgreSQL", () => {
  let pool: Pool;
  let db: Database;
  beforeAll(() => { ({ pool, db } = connect()); });
  afterAll(async () => { await pool?.end(); });

  async function fixture(label: string) {
    const f = await companyFixture(db, label);
    const freight = await f.lock((tx) => saveItem(tx, f.ctx, { sku: "FRT", name: "Delivery charge", kind: "service", unit: "trip",
      category: "", description: "", active: true, reorder: "0", purchaseAccountId: f.heads["6300"] }, undefined, 0));
    const balance = (tag: string) => readLedger(db, f.companyId, { accountId: f.heads[tag] }, day(1), end).then((result) => result.closing);
    const row = (itemId: string, quantity: string, rate: string, lineType?: "services" | "freight"): InvoiceInput["lines"][number] =>
      ({ itemId, description: "", quantity, rate, discount: "0", tax: "0", historicalCost: "0", originalLineNo: null, disposition: "saleable", lineType });
    const executive = (name: string, active = true, id?: string, version = 0) =>
      f.lock((tx) => saveSalesExecutive(tx, f.ctx, { name, phone: "", active, id, version }));
    const inspect = (id: "company-wise" | "mis" | "sales-executives", query: Record<string, string> = {}) =>
      buildReport(db, id, f.companyId, [{ id: f.companyId, name: "Fixture" }], range(query));
    return { ...f, freight: freight.id, balance, row, executive, inspect };
  }

  it("posts Services and Freight lines to their own income and expense without moving stock", async () => {
    const f = await fixture("Line types");
    const purchase = await f.post(f.invoice("purchase", day(2), "10", "100", {
      lines: [f.row(f.item, "10", "100"), f.row(f.freight, "1", "300", "freight"), f.row(f.freight, "1", "40", "services")],
    }));
    expect(await f.balance("inventory")).toBe("1000.00");
    expect(await f.balance("freight_expense")).toBe("300.00");
    expect(await f.balance("service_expense")).toBe("40.00");
    expect(new Exact(await f.balance("6300")).isZero()).toBe(true);
    const sale = await f.post(f.invoice("sale", day(3), "4", "150", {
      lines: [f.row(f.item, "4", "150"), f.row(f.freight, "1", "200", "freight"), f.row(f.freight, "2", "25", "services")],
    }));
    expect(await f.balance("sales")).toBe("-600.00");
    expect(await f.balance("freight_income")).toBe("-200.00");
    expect(await f.balance("service_income")).toBe("-50.00");
    expect(await f.balance("cogs")).toBe("400.00");
    expect(await f.balance("inventory")).toBe("600.00");
    expect(await f.balance("receivable")).toBe("850.00");
    const moves = await db.select().from(schema.stockMoves).where(eq(schema.stockMoves.companyId, f.companyId));
    expect(moves.every((move) => move.itemId === f.item)).toBe(true);
    const detail = await invoiceDetail(db, f.companyId, sale.id);
    expect(detail!.lines.map((row) => row.lineType)).toEqual(["product", "freight", "services"]);
    // Product lines keep the pre-existing calculation shape, so their effect fingerprint does not change.
    const calc = detail!.invoice.calculation as InvoiceCalculation;
    expect("lineType" in calc.lines[0]).toBe(false);
    expect(calc.lines[1].lineType).toBe("freight");

    const returned = f.invoice("sale_return", day(4), "1", "0", { originalInvoiceId: sale.id,
      lines: [{ ...f.row(f.freight, "1", "0"), originalLineNo: 2 }] });
    await f.post(returned);
    expect(await f.balance("sales_returns")).toBe("200.00");
    expect(await f.balance("inventory")).toBe("600.00");
    const back = f.invoice("purchase_return", day(5), "1", "0", { originalInvoiceId: purchase.id,
      lines: [{ ...f.row(f.freight, "1", "0"), originalLineNo: 2 }] });
    await f.post(back);
    expect(new Exact(await f.balance("freight_expense")).isZero()).toBe(true);

    const profit = await buildReport(db, "profit-loss", f.companyId, [{ id: f.companyId, name: "Fixture" }], range());
    expect(values(profit, "Gross Sales")?.at(-1)).toBe("850.00");
    // Service and freight income count as sales in the reconciliation, as they do in the Profit & Loss.
    const checks = (await db.transaction((tx) => reconcile(tx, f.companyId, { from: day(1), to: end }),
      { isolationLevel: "repeatable read", accessMode: "read only" })).checks;
    expect(checks.filter((c) => c.status !== "pass").map((c) => `${c.key}: ${c.summary}`)).toEqual([]);
  });

  it("rejects a stock product on a non-product line and leaves existing invoices unrevalued", async () => {
    const f = await fixture("Line guard");
    const first = await f.post(f.invoice("purchase", day(2), "5", "100"));
    const before = (await invoiceDetail(db, f.companyId, first.id))!.invoice;
    await expect(f.post(f.invoice("sale", day(3), "1", "150", { lines: [f.row(f.item, "1", "150", "freight")] })))
      .rejects.toThrow(/service item/);
    await f.post(f.invoice("sale", day(3), "1", "150", { lines: [f.row(f.item, "1", "150"), f.row(f.freight, "1", "20", "freight")] }));
    const after = (await invoiceDetail(db, f.companyId, first.id))!.invoice;
    expect(after.version).toBe(before.version);
    expect(after.effectHash).toBe(before.effectHash);
  });

  it("groups the company-wise report by account type once, with collapsible type subtotals", async () => {
    const f = await fixture("Grouping");
    await f.saveVoucher(f.voucher("JV", day(2), [f.line("cash", "debit", "500"), f.line("capital", "credit", "500")]));
    await f.saveVoucher(f.voucher("JV", day(3), [f.line("6100", "debit", "70"), f.line("6200", "debit", "30"), f.line("cash", "credit", "100")]));
    const doc = await f.inspect("company-wise");
    expect(doc.columns.slice(0, 3)).toEqual(["Account Code", "Account Type", "Account Head"]);
    const expense = doc.rows.find((row) => row.key === `${f.companyId}-expense`)!;
    expect(expense).toMatchObject({ style: "group", toggle: `${f.companyId}-expense` });
    expect(expense.cells[1].value).toBe("Expense");
    expect(expense.cells[5].value).toBe("100.00");
    const children = doc.rows.filter((row) => row.parent === expense.toggle);
    expect(children.map((row) => row.cells[0].value)).toEqual(["6100", "6200"]);
    expect(children.every((row) => row.cells[1].value === "")).toBe(true);
    expect(doc.rows.filter((row) => row.style === "group").map((row) => row.cells[1].value)).toEqual(["Asset", "Equity", "Expense"]);
    expect(values(doc, `${f.companyId}-total`)?.slice(-6)).toEqual(values(doc, "grand")?.slice(-6));

    // The pure grouping keeps type order even when the source arrives sorted by code.
    const source = await movements(db, [f.companyId], range() as ReportFilter);
    const grouped = companyWise([{ id: f.companyId, name: "Fixture" }], source.filter((row) => row.code === "1000" || row.code === "3000"), range());
    expect(grouped.rows.map((row) => row.cells[1].value)).toEqual(["Fixture", "Asset", "", "Equity", "", "Fixture subtotal", "Overall total"]);
  });

  it("shows invoice line types in the Daily MIS voucher number wise detail", async () => {
    const f = await fixture("MIS types");
    await f.post(f.invoice("purchase", day(2), "5", "100"));
    await f.post(f.invoice("sale", day(3), "1", "150", { lines: [f.row(f.item, "1", "150"), f.row(f.freight, "1", "20", "freight")] }));
    const doc = await f.inspect("mis", { mode: "vouchers", voucherType: "sale" });
    const type = doc.columns.indexOf("Invoice Line Type");
    expect(type).toBe(4);
    const byAccount = (name: string) => doc.rows.find((row) => row.cells[type + 1]?.value.includes(name))?.cells[type].value;
    expect(byAccount("Freight and Transportation Income")).toBe("Freight / Transportation");
    expect(byAccount("Sales Revenue")).toBe("Product");
    expect(byAccount("Accounts Receivable")).toBe("Freight / Transportation, Product");
    expect(doc.rows.find((row) => row.key === "total")?.cells[type + 4].value).toBe("270.00");
  });

  it("credits sales and receipts to executives and totals them per executive", async () => {
    const f = await fixture("Executives");
    const ali = await f.executive("Ali Raza");
    const sara = await f.executive("Sara Khan");
    await expect(f.executive("ali raza")).rejects.toThrow(/already exists/);
    await f.post(f.invoice("purchase", day(2), "20", "100"));
    const first = await f.post(f.invoice("sale", day(3), "2", "150", { salesExecutiveId: ali }));
    await f.post(f.invoice("sale", day(4), "1", "500", { salesExecutiveId: sara }));
    await f.post(f.invoice("sale", day(5), "1", "80"));
    await expect(f.post(f.invoice("purchase", day(5), "1", "80", { salesExecutiveId: ali }))).rejects.toThrow(/sale invoices only/);
    const returned = f.invoice("sale_return", day(6), "1", "0", { originalInvoiceId: first.id });
    returned.lines[0].originalLineNo = 1;
    await f.post(returned);
    expect((await latestSaleExecutives(db, f.companyId))[f.customer.id]).toBe(sara);

    const receipt = await f.lock((tx) => recordReceipt(tx, f.ctx, { partyId: f.customer.id, accountId: f.heads.cash, date: day(7),
      amount: "100", reference: "R-1", narration: "", salesExecutiveId: ali }));
    const bank = await f.lock((tx) => recordReceipt(tx, f.ctx, { partyId: f.customer.id, accountId: f.heads.bank, date: day(8),
      amount: "250", reference: "", narration: "", salesExecutiveId: sara }));
    const [cashDoc, bankDoc] = await Promise.all([receipt.id, bank.id].map(async (id) =>
      (await db.select().from(schema.voucherDocuments).where(eq(schema.voucherDocuments.id, id)))[0]));
    expect([cashDoc.type, cashDoc.status, cashDoc.salesExecutiveId]).toEqual(["CRV", "posted", ali]);
    expect([bankDoc.type, bankDoc.salesExecutiveId]).toEqual(["BRV", sara]);
    expect(await f.balance("receivable")).toBe("380.00");

    const doc = await f.inspect("sales-executives");
    expect(doc.columns).toEqual(["Sr #","Date","Sales Executive Name","Party Name","Invoice / Voucher #","Sale Amount","Amount Received","Total"]);
    expect(values(doc, `executive-${ali}`)?.slice(2)).toEqual(["Ali Raza", "", "", "150.00", "100.00", "50.00"]);
    expect(values(doc, `executive-${sara}`)?.slice(5)).toEqual(["500.00", "250.00", "250.00"]);
    expect(values(doc, "executive-unassigned")?.slice(2)).toEqual(["No sales executive", "", "", "80.00", "0.00", "80.00"]);
    expect(values(doc, "grand")?.slice(5)).toEqual(["730.00", "350.00", "380.00"]);
    const aliRows = doc.rows.filter((row) => row.parent === `executive-${ali}`);
    expect(aliRows.map((row) => [row.cells[0].value, row.cells[2].value, row.cells[5].value, row.cells[6].value, row.cells[7].value]))
      .toEqual([["1", "", "300.00", "", "300.00"], ["2", "", "-150.00", "", "150.00"], ["3", "", "", "100.00", "50.00"]]);

    const extra = await f.post(f.invoice("sale", day(10), "1", "10", { salesExecutiveId: ali }));
    await f.executive("Ali Raza", false, ali, 1);
    await expect(f.post(f.invoice("sale", day(9), "1", "10", { salesExecutiveId: ali }))).rejects.toThrow(/active sales executive/);
    await expect(f.lock((tx) => recordReceipt(tx, f.ctx, { partyId: f.customer.id, accountId: f.heads.cash, date: day(9),
      amount: "5", reference: "", narration: "", salesExecutiveId: ali }))).rejects.toThrow(/active sales executive/);
    // Revising a document that already carries an inactive executive keeps it.
    const kept = (await invoiceDetail(db, f.companyId, extra.id))!.invoice;
    await f.post(f.invoice("sale", day(10), "1", "12", { salesExecutiveId: ali }), extra.id, kept.version);
    expect((await invoiceDetail(db, f.companyId, extra.id))!.invoice.salesExecutiveId).toBe(ali);
    expect((await f.inspect("sales-executives", { q: "ali" })).rows.filter((row) => row.parent).length).toBe(4);
  });

  it("submits receipts under approval and counts them only once posted", async () => {
    const f = await fixture("Receipt approval");
    const ali = await f.executive("Approval exec");
    await db.update(schema.companySettings).set({ voucherApproval: true }).where(eq(schema.companySettings.companyId, f.companyId));
    const submitted = await f.lock((tx) => recordReceipt(tx, f.ctx, { partyId: f.customer.id, accountId: f.heads.cash, date: day(7),
      amount: "40", reference: "", narration: "", salesExecutiveId: ali }));
    const [doc] = await db.select().from(schema.voucherDocuments)
      .where(and(eq(schema.voucherDocuments.companyId, f.companyId), eq(schema.voucherDocuments.id, submitted.id)));
    expect([doc.status, doc.submittedBy, doc.salesExecutiveId]).toEqual(["draft", f.userId, ali]);
    expect((await f.inspect("sales-executives")).rows).toHaveLength(0);
    await expect(f.lock((tx) => recordReceipt(tx, f.ctx, { partyId: f.supplier.id, accountId: f.heads.cash, date: day(7),
      amount: "40", reference: "", narration: "", salesExecutiveId: null }))).rejects.toThrow(/active customer/);
    const count = await db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM voucher_documents WHERE company_id=${f.companyId}`);
    expect(count.rows[0].n).toBe("1");
  });

  it("builds executive groups from activity rows with running totals", () => {
    const row = (id: string, executiveId: string | null, sale: string, received: string): ExecutiveActivity => ({
      id, kind: received === "0" ? "sale" : "receipt", executiveId, executive: executiveId && `Exec ${executiveId}`, day: day(2), number: id,
      partyId: null, party: "Party", sale, received,
    });
    const rows = executiveRows("c", [row("a", "1", "100", "0"), row("b", "1", "0", "60"), row("c", null, "10", "0")], range());
    expect(rows.map((r) => [r.key, r.cells[7].value])).toEqual([
      ["executive-1", "40.00"], ["sale-a", "100.00"], ["receipt-b", "40.00"], ["executive-unassigned", "10.00"], ["sale-c", "10.00"], ["grand", "50.00"],
    ]);
  });
});
