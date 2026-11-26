import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database, Transaction } from "../src/db";
import * as schema from "../src/db/schema";
import { insertCompany } from "../src/db/seed";
import { Exact } from "../src/lib/engine/model";
import { partyBalances, readLedger } from "../src/lib/engine/read";
import { invoiceOutstanding } from "../src/lib/engine/settlement";
import type { FinanceContext } from "../src/lib/engine/vouchers";
import type { AdjustmentInput, InvoiceInput, TradeType } from "../src/lib/trade/model";
import { inventorySummary, invoiceDetail, stockLedger } from "../src/lib/trade/read";
import { saveAdjustment, saveInvoice, saveItem, tradeLifecycle } from "../src/lib/trade/service";

const url = process.env.AZAM_TEST_DATABASE_URL;
const end = "2026-12-31";
const day = (number: number) => `2026-01-${String(number).padStart(2, "0")}`;

describe.skipIf(!url)("trade documents and moving-average stock on PostgreSQL", () => {
  let pool: Pool;
  let db: Database;

  beforeAll(async () => {
    if (!url || !new URL(url).pathname.endsWith("_test")) throw new Error("Use a disposable _test PostgreSQL database.");
    pool = new Pool({ connectionString: url });
    db = drizzle(pool, { schema });
  });
  afterAll(async () => { await pool?.end(); });

  async function fixture() {
    const fixture = await db.transaction(async (tx) => {
      const token = randomUUID();
      const company = await insertCompany(tx, `Trade fixture ${token}`);
      const companyId = company.id;
      const [user] = await tx.insert(schema.users).values({
        username: `trade-${token}`, displayName: "Trade tester", passwordHash: "test-only",
      }).returning();
      const ctx: FinanceContext = { companyId, actorId: user.id, require: () => undefined };
      const [year] = await tx.insert(schema.financialYears).values({ companyId, name: "2026", startsOn: day(1), endsOn: end }).returning();
      const time = await tx.insert(schema.periods).values([
        { companyId, yearId: year.id, startsOn: day(1), endsOn: day(15) },
        { companyId, yearId: year.id, startsOn: day(16), endsOn: end },
      ]).returning();
      const [customer, supplier] = await tx.insert(schema.parties).values([
        { companyId, name: "Test customer", type: "customer" }, { companyId, name: "Test supplier", type: "supplier" },
      ]).returning();
      const heads = Object.fromEntries((await tx.select().from(schema.accounts).where(eq(schema.accounts.companyId, companyId))).map((a) => [a.control ?? a.code, a.id]));
      const item = await saveItem(tx, ctx, {
        sku: "TEST-01", name: "Weighted item", kind: "stock", unit: "unit", category: "", description: "", active: true,
        reorder: "0", purchaseAccountId: null,
      }, undefined, 0);
      return { ctx, companyId, heads, customer, supplier, item: item.id, time };
    });
    const lock = <T,>(run: (tx: Transaction) => Promise<T>) => db.transaction(async (tx) => {
      await tx.execute(sql`select id from companies where id=${fixture.companyId} for update`);
      return run(tx);
    });
    const input = (type: TradeType, date: string, quantity: string, rate: string, extra: Partial<InvoiceInput> = {}): InvoiceInput => ({
      type, date, partyId: type.startsWith("sale") ? fixture.customer.id : fixture.supplier.id,
      dueOn: "", externalRef: "", poRef: "", narration: "", notes: "", reason: "Verified trade transaction",
      originalInvoiceId: null, exchangeReturnId: null, withholding: "0", duplicateReason: "", payments: [],
      lines: [{ itemId: fixture.item, description: "", quantity, rate, discount: "0", tax: "0", historicalCost: "0", originalLineNo: null, disposition: "saleable" }],
      ...extra,
    });
    const post = (input: InvoiceInput, id?: string, version = 0, intent: "draft" | "post" = "post") =>
      lock((tx) => saveInvoice(tx, fixture.ctx, { input, id, version, intent, reason: "Trade test correction" }));
    const read = (id: string) => invoiceDetail(db, fixture.companyId, id).then((data) => data!.invoice);
    const stock = () => inventorySummary(db, fixture.companyId, end, fixture.item).then((rows) => rows[0]);
    const balance = (tag: string) => readLedger(db, fixture.companyId, { accountId: fixture.heads[tag] }, day(1), end).then((result) => result.closing);
    const change = (id: string, version: number, operation: "void" | "restore") =>
      lock((tx) => tradeLifecycle(tx, fixture.ctx, "invoice", id, version, operation, "Verified trade lifecycle"));
    return { ...fixture, lock, input, post, read, stock, balance, change };
  }

  it("reconciles the required purchase, sale and return acceptance case", async () => {
    const f = await fixture();
    await f.post(f.input("purchase", day(2), "10", "1000"));
    const sale = await f.post(f.input("sale", day(3), "4", "1500"));
    const returned = f.input("sale_return", day(4), "1", "0", { originalInvoiceId: sale.id });
    returned.lines[0].originalLineNo = 1;
    await f.post(returned);
    expect(await f.stock()).toMatchObject({ qty: "7.000000", value: "7000.00", average: "1000.0000000000" });
    const netSales = new Exact(await f.balance("sales")).plus(await f.balance("sales_returns")).negated();
    const cogs = new Exact(await f.balance("cogs"));
    expect(netSales.toFixed(2)).toBe("4500.00");
    expect(cogs.toFixed(2)).toBe("3000.00");
    expect(netSales.minus(cogs).toFixed(2)).toBe("1500.00");
    const party = await partyBalances(db, f.companyId, end);
    expect(party.find((row) => row.id === f.customer.id)?.balance).toBe("4500.00");
    expect(party.find((row) => row.id === f.supplier.id)?.balance).toBe("-10000.00");
    expect((await invoiceOutstanding(db, f.companyId, end, f.customer.id))[0].outstanding).toBe("4500.00");
  });

  it("replays backdated costs, rejects locked revaluation and protects against historical negative stock", async () => {
    const f = await fixture();
    const purchase = await f.post(f.input("purchase", day(10), "10", "1000"));
    await f.post(f.input("sale", day(20), "7", "1500"));
    const later = await f.post(f.input("purchase", day(22), "10", "1000"));
    await expect(f.post(f.input("sale", day(8), "1", "1500"))).rejects.toThrow(/Insufficient historical stock/);
    const base = await f.read(purchase.id);
    await db.update(schema.periods).set({ closed: true }).where(eq(schema.periods.id, f.time[1].id));
    await expect(f.post(f.input("purchase", day(12), "10", "2000"))).rejects.toThrow(/closed/);
    expect(await f.balance("cogs")).toBe("7000.00");
    await db.update(schema.periods).set({ closed: false }).where(eq(schema.periods.id, f.time[1].id));
    await f.post(f.input("purchase", day(12), "10", "2000"));
    expect(await f.balance("cogs")).toBe("10500.00");
    await f.post(f.input("purchase", day(10), "10", "1200"), purchase.id, base.version);
    expect(await f.balance("cogs")).toBe("11200.00");
    expect((await f.read(purchase.id)).number).toBe(base.number);
    const old = await f.read(later.id);
    await f.change(later.id, old.version, "void");
    expect(await f.stock()).toMatchObject({ qty: "13.000000", value: "20800.00" });
    await f.change(later.id, old.version + 1, "restore");
    expect(await f.stock()).toMatchObject({ qty: "23.000000", value: "30800.00" });
    expect((await f.read(later.id)).number).toBe(old.number);
  });

  it("posts supplier-return variance, mixed settlement, and damaged returns without restocking damaged goods", async () => {
    const f = await fixture();
    const first = await f.post(f.input("purchase", day(2), "10", "1000", { externalRef: "Supplier-01" }));
    await expect(f.post(f.input("purchase", day(2), "10", "2000", { externalRef: "supplier-01" }))).rejects.toThrow(/already exists/);
    await f.post(f.input("purchase", day(2), "10", "2000", { externalRef: "supplier-01", duplicateReason: "Approved exception for duplicate vendor reference" }));
    const back = f.input("purchase_return", day(3), "2", "0", { originalInvoiceId: first.id });
    back.lines[0].originalLineNo = 1;
    await f.post(back);
    expect(await f.balance("purchase_return_variance")).toBe("1000.00");
    expect(await f.stock()).toMatchObject({ qty: "18.000000", value: "27000.00" });
    const mixed = await f.post(f.input("sale", day(4), "2", "2500", {
      payments: [{ accountId: f.heads.cash, amount: "1000" }, { accountId: f.heads.bank, amount: "2000" }],
    }));
    expect((await f.read(mixed.id)).partyAmount).toBe("2000.00");
    expect(await f.balance("cash")).toBe("1000.00");
    expect(await f.balance("bank")).toBe("2000.00");
    const damaged = f.input("sale_return", day(5), "1", "0", { originalInvoiceId: mixed.id });
    damaged.lines[0].originalLineNo = 1;
    damaged.lines[0].disposition = "damaged";
    await f.post(damaged);
    expect(await f.stock()).toMatchObject({ qty: "16.000000", value: "24000.00" });
    expect(await f.balance("inventory_loss")).toBe("1500.00");
    expect(await f.balance("cogs")).toBe("1500.00");
    expect((await invoiceOutstanding(db, f.companyId, end, f.customer.id))[0].outstanding).toBe("0.00");
    const excess = { ...damaged, lines: [{ ...damaged.lines[0], quantity: "2" }] };
    await expect(f.post(excess)).rejects.toThrow(/Cumulative returns exceed/);
    await expect(f.change(mixed.id, (await f.read(mixed.id)).version, "void")).rejects.toThrow(/linked/);
  });

  it("posts approved tax and withholding amounts on a service purchase without moving stock", async () => {
    const f = await fixture();
    const service = await f.lock((tx) => saveItem(tx, f.ctx, {
      sku: "SERVICE", name: "Test service", kind: "service", unit: "hour", category: "Service", description: "", active: true,
      reorder: "0", purchaseAccountId: f.heads["6300"],
    }, undefined, 0));
    const purchase = f.input("purchase", day(2), "2", "50", {
      withholding: "5", payments: [{ accountId: f.heads.bank, amount: "20" }],
    });
    purchase.lines[0] = { ...purchase.lines[0], itemId: service.id, tax: "10" };
    await expect(f.post(purchase)).rejects.toThrow(/disabled/);
    await db.update(schema.companySettings).set({ tradeTax: true, tradeWithholding: true })
      .where(eq(schema.companySettings.companyId, f.companyId));
    const bought = await f.post(purchase);
    expect((await f.read(bought.id))).toMatchObject({ partyAmount: "85.00", total: "110.00" });
    expect(await f.balance("6300")).toBe("100.00");
    expect(await f.balance("input_tax")).toBe("10.00");
    expect(await f.balance("withholding_payable")).toBe("-5.00");
    expect(await f.balance("inventory")).toBe("0");
    expect(await stockLedger(db, f.companyId, service.id, day(1), end)).toHaveLength(0);
    const returned = f.input("purchase_return", day(3), "1", "0", {
      originalInvoiceId: bought.id, withholding: "2.50", payments: [{ accountId: f.heads.bank, amount: "10" }],
    });
    returned.lines[0] = { ...returned.lines[0], originalLineNo: 1, itemId: service.id };
    await f.post(returned);
    expect(await f.balance("6300")).toBe("50.00");
    expect(await f.balance("input_tax")).toBe("5.00");
    expect(await f.balance("withholding_payable")).toBe("-2.50");
  });

  it("posts audited opening, physical-count and valuation adjustments and voids an unchanged count safely", async () => {
    const f = await fixture();
    const base: AdjustmentInput = { itemId: f.item, kind: "opening", date: day(1), quantity: "4", physical: "0", rate: "25",
      valueChange: "0", reference: "COUNT-REF", reason: "Authorized inventory adjustment" };
    await f.lock((tx) => saveAdjustment(tx, f.ctx, base));
    expect(await f.balance("opening_equity")).toBe("-100.00");
    await f.lock((tx) => saveAdjustment(tx, f.ctx, { ...base, date: day(2), kind: "count", physical: "3" }));
    expect(await f.stock()).toMatchObject({ qty: "3.000000", value: "75.00" });
    await f.lock((tx) => saveAdjustment(tx, f.ctx, { ...base, date: day(3), kind: "valuation", valueChange: "15" }));
    expect(await f.stock()).toMatchObject({ qty: "3.000000", value: "90.00", average: "30.0000000000" });
    const count = await f.lock((tx) => saveAdjustment(tx, f.ctx, { ...base, date: day(4), kind: "count", physical: "3" }));
    const [record] = await db.select().from(schema.inventoryAdjustments).where(eq(schema.inventoryAdjustments.id, count.id));
    await f.lock((tx) => tradeLifecycle(tx, f.ctx, "inventory_adjustment", record.id, record.version, "void", "Duplicate physical count check"));
    expect(await f.stock()).toMatchObject({ qty: "3.000000", value: "90.00" });
    expect(await f.balance("inventory")).toBe("90.00");
  });

  it("serializes simultaneous sales and preserves fractional and zero-cost stock through complete depletion", async () => {
    const f = await fixture();
    const opening: AdjustmentInput = {
      itemId: f.item, kind: "opening", date: day(1), quantity: "2.500000", physical: "0", rate: "0", valueChange: "0",
      reference: "Zero-cost inventory", reason: "Authorized free-stock opening",
    };
    await f.lock((tx) => saveAdjustment(tx, f.ctx, opening));
    const results = await Promise.allSettled([
      f.post(f.input("sale", day(3), "1.5", "10")),
      f.post(f.input("sale", day(3), "1.5", "10")),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    await f.post(f.input("sale", day(4), "1", "10"));
    expect(await f.stock()).toMatchObject({ qty: "0.000000", value: "0.00", average: "0" });
    expect(await f.balance("cogs")).toBe("0");
    const zeroItem = await f.lock((tx) => saveItem(tx, f.ctx, {
      sku: "FREE-SVC", name: "Complimentary service", kind: "service", unit: "hour", category: "", description: "", active: true, reorder: "0",
      purchaseAccountId: f.heads["6300"],
    }, undefined, 0));
    const complimentary = f.input("sale", day(5), "1", "0");
    complimentary.lines[0].itemId = zeroItem.id;
    expect((await f.read((await f.post(complimentary)).id)).total).toBe("0.00");
    const movement = await stockLedger(db, f.companyId, f.item, day(1), end);
    expect(movement.map((row) => [row.kind, row.qtyAfter])).toEqual([["opening","2.500000"],["sale","1.000000"],["sale","0.000000"]]);
  });
});
