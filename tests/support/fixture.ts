import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { Database, Transaction } from "../../src/db";
import * as schema from "../../src/db/schema";
import { insertCompany } from "../../src/db/seed";
import type { VoucherInput } from "../../src/lib/engine/model";
import { saveManual, type FinanceContext } from "../../src/lib/engine/vouchers";
import type { InvoiceInput, TradeType } from "../../src/lib/trade/model";
import { saveInvoice, saveItem } from "../../src/lib/trade/service";

export const testUrl = process.env.AZAM_TEST_DATABASE_URL;
export const end = "2026-12-31";
export const day = (n: number) => `2026-01-${String(n).padStart(2, "0")}`;

export function connect() {
  if (!testUrl || !new URL(testUrl).pathname.endsWith("_test")) throw new Error("Use a disposable _test PostgreSQL database.");
  const pool = new Pool({ connectionString: testUrl, max: 6 });
  return { pool, db: drizzle(pool, { schema }) as Database };
}

/** A fresh company with one financial year, two periods, a customer, a supplier and a stock item. */
export async function companyFixture(db: Database, label = "Phase5") {
  const base = await db.transaction(async (tx) => {
    const token = randomUUID();
    const company = await insertCompany(tx, `${label} ${token}`);
    const companyId = company.id;
    const [user] = await tx.insert(schema.users).values({ username: `p5-${token}`, displayName: "Phase 5 tester", passwordHash: "test-only" }).returning();
    const ctx: FinanceContext = { companyId, actorId: user.id, require: () => undefined };
    const [year] = await tx.insert(schema.financialYears).values({ companyId, name: "2026", startsOn: day(1), endsOn: end }).returning();
    const periods = await tx.insert(schema.periods).values([
      { companyId, yearId: year.id, startsOn: day(1), endsOn: day(15) },
      { companyId, yearId: year.id, startsOn: day(16), endsOn: end },
    ]).returning();
    const [customer, supplier] = await tx.insert(schema.parties).values([
      { companyId, name: "Shared name", type: "customer" }, { companyId, name: "Shared name", type: "supplier" },
    ]).returning();
    const heads = Object.fromEntries((await tx.select().from(schema.accounts).where(eq(schema.accounts.companyId, companyId)))
      .map((a) => [a.control ?? a.code, a.id]));
    const item = await saveItem(tx, ctx, { sku: `SKU-${token.slice(0, 8)}`, name: "Stock item", kind: "stock", unit: "unit",
      category: "", description: "", active: true, reorder: "0", purchaseAccountId: null }, undefined, 0);
    return { ctx, companyId, userId: user.id, yearId: year.id, periods, customer, supplier, heads, item: item.id };
  });
  const lock = <T,>(run: (tx: Transaction) => Promise<T>) => db.transaction(async (tx) => {
    await tx.execute(sql`select id from companies where id=${base.companyId} for update`);
    return run(tx);
  });
  const invoice = (type: TradeType, date: string, quantity: string, rate: string, extra: Partial<InvoiceInput> = {}): InvoiceInput => ({
    type, date, partyId: type.startsWith("sale") ? base.customer.id : base.supplier.id,
    dueOn: "", externalRef: "", poRef: "", narration: "", notes: "", reason: "Phase 5 verification",
    originalInvoiceId: null, exchangeReturnId: null, withholding: "0", duplicateReason: "", payments: [],
    lines: [{ itemId: base.item, description: "", quantity, rate, discount: "0", tax: "0", historicalCost: "0", originalLineNo: null, disposition: "saleable" }],
    ...extra,
  });
  const post = (input: InvoiceInput, id?: string, version = 0, intent: "draft" | "post" = "post") =>
    lock((tx) => saveInvoice(tx, base.ctx, { input, id, version, intent, reason: "Phase 5 correction" }));
  const line = (account: string, side: "debit" | "credit", amount: string, partyId: string | null = null) =>
    ({ accountId: base.heads[account] ?? account, partyId, description: "", debit: side === "debit" ? amount : "0", credit: side === "credit" ? amount : "0" });
  const voucher = (type: VoucherInput["type"], date: string, lines: VoucherInput["lines"], mode: VoucherInput["mode"] = "direct"): VoucherInput =>
    ({ type, lines, mode, date, reference: "P5", narration: "Phase 5 verification" });
  const saveVoucher = (entry: VoucherInput, intent: "draft" | "post" | "submit" = "post", id?: string, version = 0) =>
    lock((tx) => saveManual(tx, base.ctx, { entry, intent, id, version, reason: id ? "Phase 5 correction" : "" }));
  return { ...base, lock, invoice, post, line, voucher, saveVoucher };
}
