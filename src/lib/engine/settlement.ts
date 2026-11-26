import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database, Transaction } from "../../db";
import { allocations, auditLogs } from "../../db/schema";
import { AccountingError, Exact } from "./model";
import { openPeriod } from "./posting";
import type { FinanceContext } from "./vouchers";

type Reader = Database | Transaction;

export async function invoiceOutstanding(db: Reader, companyId: string, date: string, partyId?: string) {
  const result = await db.execute<{
    id: string; partyId: string; party: string; type: "sale" | "purchase"; number: string; date: string; dueOn: string;
    invoiceAmount: string; embeddedSettlement: string; creditNotes: string; allocated: string; outstanding: string; overdueDays: number;
  }>(sql`
    WITH base AS (
      SELECT i.*,p.name AS party FROM invoices i
      JOIN effective_vouchers v ON v.company_id=i.company_id AND v.id=i.voucher_id
      JOIN parties p ON p.company_id=i.company_id AND p.id=i.party_id
      WHERE i.company_id=${companyId} AND i.status='posted' AND i.type IN ('sale','purchase')
        AND i.accounting_date<=${date}::date AND (${partyId ?? null}::uuid IS NULL OR i.party_id=${partyId ?? null}::uuid)
    ), credits AS (
      SELECT o.id,sum(coalesce(r.applied_credit,r.total)) AS amount FROM base o
      JOIN invoices r ON r.company_id=o.company_id AND r.original_invoice_id=o.id AND r.party_id=o.party_id
      JOIN effective_vouchers v ON v.company_id=r.company_id AND v.id=r.voucher_id
      WHERE r.status='posted' AND r.accounting_date<=${date}::date
        AND ((o.type='sale' AND r.type='sale_return') OR (o.type='purchase' AND r.type='purchase_return'))
      GROUP BY o.id
    ), paid AS (
      SELECT o.id,sum(a.amount) AS amount FROM base o
      JOIN payment_allocations a ON a.company_id=o.company_id AND a.invoice_id=o.id
      JOIN journal_lines l ON l.company_id=a.company_id AND l.id=a.payment_line_id AND l.party_id=o.party_id
      JOIN effective_vouchers v ON v.company_id=l.company_id AND v.id=l.voucher_id
      WHERE a.accounting_date<=${date}::date AND v.accounting_date<=${date}::date
        AND (a.ended_on IS NULL OR a.ended_on>${date}::date)
        AND ((o.type='sale' AND l.credit>0) OR (o.type='purchase' AND l.debit>0))
      GROUP BY o.id
    )
    SELECT b.id,b.party_id AS "partyId",b.party,b.type,b.number,b.accounting_date::text AS date,
      coalesce(b.due_on,b.accounting_date)::text AS "dueOn",b.total::text AS "invoiceAmount",
      (b.total-coalesce(b.party_amount,b.total))::text AS "embeddedSettlement",
      coalesce(c.amount,0)::text AS "creditNotes",coalesce(p.amount,0)::text AS allocated,
      greatest(coalesce(b.party_amount,b.total)-coalesce(c.amount,0)-coalesce(p.amount,0),0)::text AS outstanding,
      greatest(${date}::date-coalesce(b.due_on,b.accounting_date),0) AS "overdueDays"
    FROM base b LEFT JOIN credits c ON c.id=b.id LEFT JOIN paid p ON p.id=b.id
    ORDER BY b.accounting_date,b.number,b.id
  `);
  return result.rows;
}

export async function paymentSources(db: Reader, companyId: string, partyId: string, date: string) {
  const result = await db.execute<{
    id: string; documentId: string; date: string; number: string; amount: string; allocated: string; unallocated: string;
  }>(sql`
    WITH used AS (
      SELECT a.payment_line_id,sum(a.amount) AS amount
      FROM payment_allocations a JOIN invoices i ON i.company_id=a.company_id AND i.id=a.invoice_id AND i.status='posted'
      JOIN effective_vouchers iv ON iv.company_id=i.company_id AND iv.id=i.voucher_id
      WHERE a.company_id=${companyId} AND a.accounting_date<=${date}::date AND (a.ended_on IS NULL OR a.ended_on>${date}::date)
      GROUP BY a.payment_line_id
    )
    SELECT l.id,v.document_id AS "documentId",v.accounting_date::text AS date,v.number,
      (l.debit+l.credit)::text AS amount,(coalesce(a.amount,0)+coalesce(n.applied_credit,0))::text AS allocated,
      greatest(l.debit+l.credit-coalesce(a.amount,0)-coalesce(n.applied_credit,0),0)::text AS unallocated
    FROM parties p JOIN journal_lines l ON l.company_id=p.company_id AND l.party_id=p.id
    JOIN accounts g ON g.company_id=l.company_id AND g.id=l.account_id
    JOIN effective_vouchers v ON v.company_id=l.company_id AND v.id=l.voucher_id
    LEFT JOIN used a ON a.payment_line_id=l.id
    LEFT JOIN invoices n ON n.company_id=v.company_id AND n.voucher_id=v.id AND n.original_invoice_id IS NOT NULL
      AND n.type IN ('sale_return','purchase_return') AND n.status='posted'
    WHERE p.company_id=${companyId} AND p.id=${partyId} AND v.accounting_date<=${date}::date
      AND ((p.type='customer' AND g.control='receivable' AND l.credit>0) OR (p.type='supplier' AND g.control='payable' AND l.debit>0))
      AND (n.id IS NULL OR n.applied_credit IS NOT NULL)
    ORDER BY v.accounting_date,v.number,l.line_no
  `);
  return result.rows;
}

export async function activeAllocations(db: Reader, companyId: string, partyId: string) {
  const result = await db.execute<{ id: string; invoice: string; payment: string; date: string; amount: string }>(sql`
    SELECT a.id,i.number AS invoice,v.number AS payment,a.accounting_date::text AS date,a.amount::text
    FROM payment_allocations a JOIN invoices i ON i.company_id=a.company_id AND i.id=a.invoice_id
    JOIN journal_lines l ON l.company_id=a.company_id AND l.id=a.payment_line_id
    JOIN effective_vouchers v ON v.company_id=l.company_id AND v.id=l.voucher_id
    WHERE a.company_id=${companyId} AND i.party_id=${partyId} AND l.party_id=${partyId} AND a.ended_on IS NULL
    ORDER BY a.accounting_date DESC,a.id
  `);
  return result.rows;
}

type Allocate = { partyId: string; lineId: string; date: string; amount: string; invoiceId?: string };
const endOfBook = "9999-12-31";

export async function allocatePayment(tx: Transaction, context: FinanceContext, input: Allocate) {
  context.require("post");
  const { companyId, actorId } = context;
  await openPeriod(tx, companyId, input.date);
  const datedPayments = await paymentSources(tx, companyId, input.partyId, input.date);
  const allPayments = await paymentSources(tx, companyId, input.partyId, endOfBook);
  const datedInvoices = await invoiceOutstanding(tx, companyId, input.date, input.partyId);
  const allInvoices = await invoiceOutstanding(tx, companyId, endOfBook, input.partyId);
  const source = datedPayments.find((row) => row.id === input.lineId);
  const capacity = allPayments.find((row) => row.id === input.lineId);
  if (!source || !capacity) throw new AccountingError("Choose an eligible posted payment or advance for this party.");
  let remainder = new Exact(input.amount);
  if (remainder.lte(0) || remainder.gt(Exact.min(source.unallocated, capacity.unallocated))) {
    throw new AccountingError("Amount exceeds the unallocated payment balance.");
  }
  const outstanding = new Map(allInvoices.map((row) => [row.id, row.outstanding]));
  const targets = input.invoiceId ? datedInvoices.filter((row) => row.id === input.invoiceId) : datedInvoices;
  const values = [];
  for (const target of targets) {
    const applied = Exact.min(remainder, target.outstanding, outstanding.get(target.id) ?? "0");
    if (applied.gt(0)) {
      values.push({ companyId, invoiceId: target.id, paymentLineId: source.id, amount: applied.toFixed(2), date: input.date });
      remainder = remainder.minus(applied);
    }
    if (remainder.isZero()) break;
  }
  if (input.invoiceId && remainder.gt(0)) throw new AccountingError("Amount exceeds the invoice’s open balance.");
  if (!values.length) throw new AccountingError("This party has no eligible outstanding invoices for this allocation.");
  const ids = sql.join(values.map((value) => sql`${value.invoiceId}::uuid`), sql`, `);
  const later = await tx.execute<{ found: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM payment_allocations a WHERE a.company_id=${companyId}
        AND (a.payment_line_id=${source.id} OR a.invoice_id IN (${ids}))
        AND (a.accounting_date>${input.date}::date OR a.ended_on>${input.date}::date)
    ) AS found
  `);
  if (later.rows[0].found) throw new AccountingError("Allocate on or after the most recent allocation or release for these records.");
  await tx.insert(allocations).values(values);
  await tx.insert(auditLogs).values({
    companyId, actorId, action: "payment.allocated", data: { method: input.invoiceId ? "explicit" : "fifo", values, unallocated: remainder.toFixed(2) },
  });
  return { id: input.partyId, remaining: remainder.toFixed(2) };
}

export async function releaseAllocation(
  tx: Transaction, context: FinanceContext, input: { id: string; partyId: string; date: string; reason: string },
) {
  context.require("edit");
  context.require("post");
  const { companyId, actorId } = context;
  await openPeriod(tx, companyId, input.date);
  const active = await activeAllocations(tx, companyId, input.partyId);
  const allocation = active.find((candidate) => candidate.id === input.id);
  if (!allocation || allocation.date > input.date) throw new AccountingError("Select an active allocation and a valid release date.");
  const [ended] = await tx.update(allocations).set({ endedOn: input.date, endedBy: actorId })
    .where(and(eq(allocations.companyId, companyId), eq(allocations.id, input.id), isNull(allocations.endedOn))).returning();
  if (!ended) throw new AccountingError("This allocation was already released.");
  await tx.insert(auditLogs).values({ companyId, actorId, action: "payment.allocation_released", data: { before: allocation, after: ended, reason: input.reason } });
  return { id: input.partyId };
}
