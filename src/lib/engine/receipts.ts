import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database, Transaction } from "../../db";
import { accounts, parties, salesExecutives } from "../../db/schema";
import { AccountingError, Exact, accountDate, amount, type VoucherInput } from "./model";
import { approvalRequired, saveManual, type FinanceContext } from "./vouchers";

export const receiptSchema = z.object({
  partyId: z.uuid({ error: "Select the customer who paid." }), accountId: z.uuid({ error: "Select the cash or bank account received into." }),
  date: accountDate, amount, reference: z.string().trim().max(120), narration: z.string().trim().max(1000),
  salesExecutiveId: z.uuid().nullable(),
});
export type ReceiptInput = z.infer<typeof receiptSchema>;

/**
 * Records an amount received from a customer as a party-mode CRV (cash) or BRV (bank) through the manual voucher service,
 * so periods, numbering and the approval policy apply unchanged. Under approval the receipt is submitted, not posted.
 */
export async function recordReceipt(tx: Transaction, context: FinanceContext, input: ReceiptInput) {
  const { companyId } = context;
  if (new Exact(input.amount).lte(0)) throw new AccountingError("Enter the positive amount received.");
  const [party] = await tx.select().from(parties).where(and(eq(parties.companyId, companyId), eq(parties.id, input.partyId)));
  if (!party?.active || party.type !== "customer") throw new AccountingError("Select an active customer in this company.");
  const [account] = await tx.select().from(accounts).where(and(eq(accounts.companyId, companyId), eq(accounts.id, input.accountId)));
  if (!account?.active || !account.liquidity) throw new AccountingError("Select an active cash or bank account.");
  const [control] = await tx.select().from(accounts).where(and(eq(accounts.companyId, companyId), eq(accounts.control, "receivable")));
  if (!control?.active) throw new AccountingError("The receivables control account is unavailable.");
  if (input.salesExecutiveId) {
    const [executive] = await tx.select().from(salesExecutives)
      .where(and(eq(salesExecutives.companyId, companyId), eq(salesExecutives.id, input.salesExecutiveId)));
    if (!executive?.active) throw new AccountingError("Select an active sales executive in this company.");
  }
  const value = new Exact(input.amount).toFixed(2);
  const entry: VoucherInput = {
    type: account.liquidity === "cash" ? "CRV" : "BRV", date: input.date, reference: input.reference,
    narration: input.narration || `Amount received · ${party.name}`, mode: "party", lines: [
      { accountId: account.id, partyId: null, description: "", debit: value, credit: "0" },
      { accountId: control.id, partyId: party.id, description: "", debit: "0", credit: value },
    ],
  };
  const intent = await approvalRequired(tx, companyId) ? "submit" : "post";
  return saveManual(tx, context, { entry, version: 0, reason: "", intent, salesExecutiveId: input.salesExecutiveId });
}

/** The executive on each customer's most recent effective sale that named one, used as the receipt default. */
export async function latestSaleExecutives(db: Database | Transaction, companyId: string) {
  const rows = await db.execute<{ partyId: string; executiveId: string }>(sql`
    SELECT DISTINCT ON (i.party_id) i.party_id AS "partyId",i.sales_executive_id AS "executiveId"
    FROM invoices i JOIN effective_vouchers e ON e.company_id=i.company_id AND e.id=i.voucher_id
    WHERE i.company_id=${companyId} AND i.type='sale' AND i.status='posted' AND i.sales_executive_id IS NOT NULL
    ORDER BY i.party_id,i.accounting_date DESC,i.created_at DESC,i.id DESC
  `);
  return Object.fromEntries(rows.rows.map((row) => [row.partyId, row.executiveId]));
}
