import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database, Transaction } from "@/db";
import { accounts, companySettings, inventoryAdjustments, invoices, items, parties, salesExecutives, units, users } from "@/db/schema";
import type { InvoiceInput, LineType, TradeType } from "./model";

type Reader = Database | Transaction;
export async function tradeOptions(db: Reader, companyId: string) {
  const [settings] = await db.select().from(companySettings).where(eq(companySettings.companyId, companyId));
  const people = await db.select({ id: parties.id, name: parties.name, type: parties.type, active: parties.active, creditDays: parties.creditDays })
    .from(parties).where(eq(parties.companyId, companyId)).orderBy(parties.name);
  const goods = await db.select({ id: items.id, name: items.name, sku: items.sku, kind: items.kind, active: items.active, unit: units.name })
    .from(items).innerJoin(units, and(eq(items.unitId, units.id), eq(items.companyId, units.companyId))).where(eq(items.companyId, companyId)).orderBy(items.name);
  const heads = await db.select({ id: accounts.id, code: accounts.code, name: accounts.name, type: accounts.type,
    control: accounts.control, liquidity: accounts.liquidity }).from(accounts)
    .where(and(eq(accounts.companyId, companyId), eq(accounts.active, true))).orderBy(accounts.code);
  const executives = await db.select({ id: salesExecutives.id, name: salesExecutives.name, active: salesExecutives.active })
    .from(salesExecutives).where(eq(salesExecutives.companyId, companyId)).orderBy(salesExecutives.name);
  return { settings, people, goods, heads, executives };
}

export async function invoiceRegister(
  db: Reader, companyId: string, filter: { from: string; to: string; type?: string; status?: string; q: string; offset: number },
) {
  const result = await db.execute<{
    id: string; date: string; type: TradeType; status: string; number: string | null; party: string; externalRef: string; poRef: string;
    voucherDocumentId: string | null; voucher: string | null; total: string; count: string;
  }>(sql`
    SELECT i.id, i.accounting_date::text AS date,i.type,i.status,i.number,p.name AS party,i.external_ref AS "externalRef",i.po_ref AS "poRef",
      coalesce(d.id,v.id) AS "voucherDocumentId",coalesce(d.number,v.number) AS voucher,i.total::text,count(*) OVER ()::text AS count
    FROM invoices i JOIN parties p ON p.id=i.party_id AND p.company_id=i.company_id
    LEFT JOIN vouchers v ON v.company_id=i.company_id AND v.id=i.voucher_id
    LEFT JOIN voucher_versions w ON w.company_id=v.company_id AND w.voucher_id=v.id
    LEFT JOIN voucher_documents d ON d.company_id=w.company_id AND d.id=w.document_id
    WHERE i.company_id=${companyId} AND i.accounting_date BETWEEN ${filter.from}::date AND ${filter.to}::date
      AND (${filter.type ?? ""}='' OR i.type::text=${filter.type ?? ""})
      AND (${filter.status ?? ""}='' AND i.status<>'void' OR i.status::text=${filter.status ?? ""})
      AND (${filter.q}='' OR strpos(lower(concat_ws(' ',i.number,i.external_ref,i.po_ref,p.name,coalesce(d.number,v.number))),lower(${filter.q}))>0)
    ORDER BY i.accounting_date DESC,i.created_at DESC,i.id DESC LIMIT 40 OFFSET ${filter.offset}
  `);
  return result.rows;
}

export async function invoiceDetail(db: Reader, companyId: string, id: string) {
  const [invoice] = await db.select().from(invoices).where(and(eq(invoices.companyId, companyId), eq(invoices.id, id)));
  if (!invoice) return null;
  const lines = await db.execute<{
    lineNo: number; itemId: string; item: string; sku: string | null; unit: string; kind: string; description: string;
    qty: string; rate: string; subtotal: string; discount: string; tax: string; amount: string; inventoryCost: string; disposition: string;
    lineType: LineType;
  }>(sql`
    SELECT l.line_no AS "lineNo",l.item_id AS "itemId",g.name AS item,g.sku,coalesce(nullif(l.unit_label,''),u.name) AS unit,
      g.kind,l.description,l.quantity::text AS qty,l.rate::text,l.subtotal::text,l.discount::text,l.tax::text,l.amount::text,
      l.inventory_cost::text AS "inventoryCost",l.disposition,l.line_type AS "lineType"
    FROM invoice_lines l JOIN inventory_items g ON g.company_id=l.company_id AND g.id=l.item_id
    JOIN inventory_units u ON u.company_id=g.company_id AND u.id=g.unit_id
    WHERE l.company_id=${companyId} AND l.invoice_id=${id}
      AND (l.posting_voucher_id IS NOT DISTINCT FROM ${invoice.voucherId}::uuid OR (${invoice.payload === null} AND l.posting_voucher_id IS NULL))
    ORDER BY l.line_no
  `);
  const [party] = await db.select().from(parties).where(and(eq(parties.companyId, companyId), eq(parties.id, invoice.partyId)));
  const voucher = await voucherLink(db, companyId, invoice.voucherId);
  const [original] = invoice.originalInvoiceId ? await db.select({ number: invoices.number, id: invoices.id }).from(invoices)
    .where(and(eq(invoices.companyId, companyId), eq(invoices.id, invoice.originalInvoiceId))) : [];
  const [exchange] = invoice.exchangeReturnId ? await db.select({ number: invoices.number, id: invoices.id }).from(invoices)
    .where(and(eq(invoices.companyId, companyId), eq(invoices.id, invoice.exchangeReturnId))) : [];
  const settlements = (invoice.payload as InvoiceInput | null)?.payments ?? [];
  const paymentHeads = settlements.length ? await db.select({ id: accounts.id, name: accounts.name, liquidity: accounts.liquidity })
    .from(accounts).where(and(eq(accounts.companyId, companyId), inArray(accounts.id, settlements.map((row) => row.accountId)))) : [];
  const payments = settlements.map((row) => ({ ...row, name: paymentHeads.find((head) => head.id === row.accountId)?.name ?? "Cash or bank" }));
  const [executive] = invoice.salesExecutiveId ? await db.select({ id: salesExecutives.id, name: salesExecutives.name }).from(salesExecutives)
    .where(and(eq(salesExecutives.companyId, companyId), eq(salesExecutives.id, invoice.salesExecutiveId))) : [];
  return { invoice, lines: lines.rows, party, voucher, original, exchange, payments, executive: executive ?? null };
}

export async function registerLines(db: Reader, companyId: string, ids: string[]) {
  if (!ids.length) return [];
  const list = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
  return (await db.execute<{ invoiceId: string; lineNo: number; item: string; unit: string; qty: string; rate: string; amount: string | null; lineType: LineType }>(sql`
    SELECT l.invoice_id AS "invoiceId",l.line_no AS "lineNo",g.name AS item,coalesce(nullif(l.unit_label,''),u.name) AS unit,
      l.quantity::text AS qty,l.rate::text,l.amount::text,l.line_type AS "lineType"
    FROM invoice_lines l JOIN invoices i ON i.company_id=l.company_id AND i.id=l.invoice_id
    JOIN inventory_items g ON g.company_id=l.company_id AND g.id=l.item_id
    JOIN inventory_units u ON u.company_id=g.company_id AND u.id=g.unit_id
    WHERE l.company_id=${companyId} AND l.invoice_id IN (${list})
      AND (l.posting_voucher_id=i.voucher_id OR (i.payload IS NULL AND l.posting_voucher_id IS NULL))
    UNION ALL
    SELECT i.id,p.ordinality::integer,g.name,u.name,p.entry->>'quantity',p.entry->>'rate',NULL::text,coalesce(p.entry->>'lineType','product')
    FROM invoices i CROSS JOIN LATERAL jsonb_array_elements(i.payload->'lines') WITH ORDINALITY p(entry,ordinality)
    JOIN inventory_items g ON g.company_id=i.company_id AND g.id=(p.entry->>'itemId')::uuid
    JOIN inventory_units u ON u.company_id=g.company_id AND u.id=g.unit_id
    WHERE i.company_id=${companyId} AND i.id IN (${list}) AND i.voucher_id IS NULL
    ORDER BY "invoiceId","lineNo"
  `)).rows;
}

export async function returnedQuantities(db: Reader, companyId: string, originalId: string, excludeId?: string) {
  return (await db.execute<{ line: number; quantity: string }>(sql`
    SELECT l.original_line_no AS line,sum(l.quantity)::text AS quantity
    FROM invoice_lines l JOIN invoices i ON i.company_id=l.company_id AND i.id=l.invoice_id AND i.voucher_id=l.posting_voucher_id
    JOIN effective_vouchers v ON v.company_id=i.company_id AND v.id=i.voucher_id
    WHERE i.company_id=${companyId} AND i.original_invoice_id=${originalId}
      AND i.id IS DISTINCT FROM ${excludeId ?? null}::uuid AND i.status='posted' AND l.original_line_no IS NOT NULL
    GROUP BY l.original_line_no
  `)).rows;
}

export async function inventorySummary(db: Reader, companyId: string, asOf: string, itemId?: string) {
  return (await db.execute<{
    id: string; name: string; sku: string | null; category: string; unit: string; kind: string; active: boolean; reorder: string;
    opening: string; openingValue: string; openingDate: string | null; purchases: string; sales: string; saleReturns: string; purchaseReturns: string;
    adjusted: string; qty: string; value: string; average: string;
  }>(sql`
    WITH stats AS (
      SELECT m.item_id,
        coalesce(sum(m.signed_quantity) FILTER (WHERE m.movement_kind='opening'),0) AS opening,
        coalesce(sum(m.signed_value) FILTER (WHERE m.movement_kind='opening'),0) AS opening_value,
        min(m.accounting_date) FILTER (WHERE m.movement_kind='opening') AS opening_date,
        coalesce(sum(m.signed_quantity) FILTER (WHERE m.movement_kind='purchase'),0) AS purchases,
        coalesce(-sum(m.signed_quantity) FILTER (WHERE m.movement_kind='sale'),0) AS sales,
        coalesce(sum(m.signed_quantity) FILTER (WHERE m.movement_kind='sale_return'),0) AS sale_returns,
        coalesce(-sum(m.signed_quantity) FILTER (WHERE m.movement_kind='purchase_return'),0) AS purchase_returns,
        coalesce(sum(m.signed_quantity) FILTER (WHERE m.movement_kind NOT IN ('opening','purchase','sale','sale_return','purchase_return')),0) AS adjusted,
        sum(m.signed_quantity) AS qty,sum(m.signed_value) AS value
      FROM stock_movements m JOIN effective_vouchers v ON v.company_id=m.company_id AND v.id=m.voucher_id
      WHERE m.company_id=${companyId} AND m.accounting_date<=${asOf}::date
        AND (${itemId ?? null}::uuid IS NULL OR m.item_id=${itemId ?? null}::uuid)
      GROUP BY m.item_id
    )
    SELECT i.id,i.name,i.sku,i.category,u.name AS unit,i.kind,i.active,i.reorder_quantity::text AS reorder,
      coalesce(s.opening,0)::text AS opening,coalesce(s.opening_value,0)::text AS "openingValue",s.opening_date::text AS "openingDate",
      coalesce(s.purchases,0)::text AS purchases,coalesce(s.sales,0)::text AS sales,
      coalesce(s.sale_returns,0)::text AS "saleReturns",coalesce(s.purchase_returns,0)::text AS "purchaseReturns",
      coalesce(s.adjusted,0)::text AS adjusted,coalesce(s.qty,0)::text AS qty,coalesce(s.value,0)::text AS value,
      CASE WHEN coalesce(s.qty,0)=0 THEN '0' ELSE round(s.value/s.qty,10)::text END AS average
    FROM inventory_items i JOIN inventory_units u ON u.company_id=i.company_id AND u.id=i.unit_id
    LEFT JOIN stats s ON s.item_id=i.id
    WHERE i.company_id=${companyId} AND (${itemId ?? null}::uuid IS NULL OR i.id=${itemId ?? null}::uuid)
    ORDER BY i.name,i.id
  `)).rows;
}

export async function stockLedger(db: Reader, companyId: string, itemId: string, from: string, to: string) {
  return (await db.execute<{
    id: string; documentId: string; date: string; voucher: string; kind: string; qty: string; unitCost: string;
    value: string; qtyAfter: string; valueAfter: string; average: string;
  }>(sql`
    WITH movements AS (
      SELECT m.id,v.document_id AS "documentId",m.accounting_date AS day,v.number AS voucher,m.movement_kind AS kind,
        m.signed_quantity::text AS qty,m.unit_cost::text AS "unitCost",m.signed_value::text AS value,
        sum(m.signed_quantity) OVER timeline AS q_after,sum(m.signed_value) OVER timeline AS v_after,
        coalesce(i.created_at,a.created_at,v.created_at) AS source_created,coalesce(i.id,a.id,v.id) AS source_id,
        m.line_no,m.created_at AS movement_created
      FROM stock_movements m JOIN effective_vouchers v ON v.company_id=m.company_id AND v.id=m.voucher_id
      LEFT JOIN invoices i ON i.company_id=v.company_id AND i.voucher_id=v.id
      LEFT JOIN inventory_adjustments a ON a.company_id=v.company_id AND a.voucher_id=v.id
      WHERE m.company_id=${companyId} AND m.item_id=${itemId} AND m.accounting_date<=${to}::date
      WINDOW timeline AS (ORDER BY m.accounting_date, (m.movement_kind='opening') DESC,
        coalesce(i.created_at,a.created_at,v.created_at),coalesce(i.id,a.id,v.id),m.line_no,m.created_at,m.id)
    )
    SELECT id,"documentId",day::text AS date,voucher,kind,qty,"unitCost",value,q_after::text AS "qtyAfter",v_after::text AS "valueAfter",
      CASE WHEN q_after=0 THEN '0' ELSE round(v_after/q_after,10)::text END AS average
    FROM movements WHERE day>=${from}::date ORDER BY day,(kind='opening') DESC,source_created,source_id,line_no,movement_created,id
  `)).rows;
}

export async function readItem(db: Reader, companyId: string, itemId: string) {
  const [row] = await db.select({ item: items, unit: units.name }).from(items)
    .innerJoin(units, and(eq(items.companyId, units.companyId), eq(items.unitId, units.id)))
    .where(and(eq(items.companyId, companyId), eq(items.id, itemId)));
  return row;
}

export async function voucherLink(db: Reader, companyId: string, id: string | null) {
  if (!id) return null;
  const result = await db.execute<{ id: string; number: string }>(sql`
    SELECT coalesce(d.id,v.id) AS id,coalesce(d.number,v.number) AS number FROM vouchers v
    LEFT JOIN voucher_versions w ON w.company_id=v.company_id AND w.voucher_id=v.id
    LEFT JOIN voucher_documents d ON d.company_id=w.company_id AND d.id=w.document_id
    WHERE v.company_id=${companyId} AND v.id=${id}
  `);
  return result.rows[0] ?? null;
}

export async function adjustmentDetail(db: Reader, companyId: string, id: string) {
  const [source] = await db.select().from(inventoryAdjustments)
    .where(and(eq(inventoryAdjustments.companyId, companyId), eq(inventoryAdjustments.id, id)));
  if (!source) return null;
  const [actor] = source.createdBy ? await db.select({ name: users.displayName }).from(users).where(eq(users.id, source.createdBy)) : [];
  return { source, actor, item: source.itemId ? await readItem(db, companyId, source.itemId) : null,
    voucher: await voucherLink(db, companyId, source.voucherId) };
}

export async function tradeHistory(db: Reader, companyId: string, id: string, kind: "invoice" | "inventory_adjustment") {
  return (await db.execute<{ id: string; date: string; actor: string; reason: string; before: unknown; after: unknown }>(sql`
    SELECT r.id,(r.created_at AT TIME ZONE 'Asia/Karachi')::text AS date,u.display_name AS actor,r.reason,
      r.previous_data AS before,r.next_data AS after FROM transaction_revisions r JOIN users u ON u.id=r.actor_id
    WHERE r.company_id=${companyId} AND r.entity_id=${id} AND r.entity_type=${kind} ORDER BY r.version DESC
  `)).rows;
}
