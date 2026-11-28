import { sql } from "drizzle-orm";
import { Exact } from "@/lib/engine/model";
import type { Reader } from "./journal";
import { dateCell, integerCell, moneyCell, textCell, type Cell, type ReportDocument, type ReportFilter, type ReportRow } from "./model";

type Parts = Pick<ReportDocument,"columns"|"rows"|"notes"|"warning">;
export type ExecutiveActivity = {
  id: string; kind: "sale" | "receipt"; executiveId: string | null; executive: string | null; day: string; number: string;
  partyId: string | null; party: string | null; sale: string; received: string;
};

/**
 * Effective sales and customer receipts credited to each sales executive. A sale return reduces the sale amount of the
 * executive on its original invoice. Receipts count the customer credit of posted vouchers that record an executive.
 */
export async function executiveActivity(db: Reader, companyId: string, f: ReportFilter) {
  return (await db.execute<ExecutiveActivity>(sql`
    WITH activity AS (
      SELECT i.id::text,'sale' AS kind,coalesce(i.sales_executive_id,o.sales_executive_id) AS executive_id,i.accounting_date AS day,
        i.number,i.party_id,CASE WHEN i.type='sale_return' THEN -i.total ELSE i.total END AS sale,0::numeric AS received,e.created_at
      FROM invoices i JOIN effective_vouchers e ON e.company_id=i.company_id AND e.id=i.voucher_id
      LEFT JOIN invoices o ON o.company_id=i.company_id AND o.id=i.original_invoice_id
      WHERE i.company_id=${companyId} AND i.status='posted' AND i.type IN ('sale','sale_return')
        AND i.accounting_date BETWEEN ${f.from}::date AND ${f.to}::date
      UNION ALL
      SELECT e.document_id::text,'receipt',d.sales_executive_id,e.accounting_date,e.number,min(l.party_id::text)::uuid,
        0,coalesce(sum(l.credit-l.debit),0),e.created_at
      FROM effective_vouchers e JOIN voucher_documents d ON d.company_id=e.company_id AND d.id=e.document_id
      JOIN journal_lines l ON l.company_id=e.company_id AND l.voucher_id=e.id AND l.party_id IS NOT NULL
      WHERE e.company_id=${companyId} AND d.sales_executive_id IS NOT NULL AND e.accounting_date BETWEEN ${f.from}::date AND ${f.to}::date
      GROUP BY e.document_id,d.sales_executive_id,e.accounting_date,e.number,e.created_at
    )
    SELECT a.id,a.kind,a.executive_id AS "executiveId",x.name AS executive,a.day::text AS day,a.number,
      a.party_id AS "partyId",p.name AS party,a.sale::text AS sale,a.received::text AS received
    FROM activity a LEFT JOIN sales_executives x ON x.company_id=${companyId} AND x.id=a.executive_id
    LEFT JOIN parties p ON p.company_id=${companyId} AND p.id=a.party_id
    WHERE (${f.party ?? null}::uuid IS NULL OR a.party_id=${f.party ?? null}::uuid)
      AND (${f.search}='' OR strpos(lower(concat_ws(' ',x.name,p.name,a.number)),lower(${f.search}))>0)
    ORDER BY x.name IS NULL,lower(x.name),a.executive_id,a.day,a.created_at,a.id
  `)).rows;
}

export function executiveRows(companyId: string, data: ExecutiveActivity[], f: ReportFilter): ReportRow[] {
  const groups = new Map<string, ExecutiveActivity[]>();
  for (const row of data) {
    const key = row.executiveId ?? "unassigned";
    groups.set(key, [...groups.get(key) ?? [], row]);
  }
  const total = (rows: ExecutiveActivity[], field: "sale" | "received") => rows.reduce((sum, row) => sum.plus(row[field]), new Exact(0));
  const href = (row: ExecutiveActivity) => row.kind === "sale" ? `/workspace/${companyId}/trade/invoices/${row.id}`
    : `/workspace/${companyId}/accounting/vouchers/${row.id}`;
  const ledger = (party: string) => `/workspace/${companyId}/reports/party-ledger?${new URLSearchParams({ party, from: f.from, to: f.to })}`;
  const rows: ReportRow[] = [];
  for (const [key, entries] of groups) {
    const sales = total(entries, "sale");
    const received = total(entries, "received");
    const toggle = `executive-${key}`;
    rows.push({ key: toggle, style: "group", toggle, cells: [textCell(""), textCell(""),
      textCell(entries[0].executive ?? "No sales executive"), textCell(""), textCell(""), moneyCell(sales), moneyCell(received), moneyCell(sales.minus(received))] });
    let running = new Exact(0);
    entries.forEach((entry, index) => {
      running = running.plus(entry.sale).minus(entry.received);
      const amount = (value: string): Cell => new Exact(value).isZero() ? textCell("") : moneyCell(value);
      rows.push({ key: `${entry.kind}-${entry.id}`, parent: toggle, cells: [integerCell(index + 1), dateCell(entry.day), textCell(""),
        textCell(entry.party ?? "", entry.partyId ? ledger(entry.partyId) : undefined), textCell(entry.number, href(entry)),
        amount(entry.sale), amount(entry.received), moneyCell(running)] });
    });
  }
  if (data.length) {
    const sales = total(data, "sale");
    const received = total(data, "received");
    rows.push({ key: "grand", style: "total", cells: [textCell("Grand total"), textCell(""), textCell(""), textCell(""), textCell(""),
      moneyCell(sales), moneyCell(received), moneyCell(sales.minus(received))] });
  }
  return rows;
}

export async function salesExecutiveReport(db: Reader, companyId: string, f: ReportFilter): Promise<Parts> {
  const data = await executiveActivity(db, companyId, f);
  return {
    columns: ["Sr #","Date","Sales Executive Name","Party Name","Invoice / Voucher #","Sale Amount","Amount Received","Total"],
    rows: executiveRows(companyId, data, f),
    notes: [
      "Sale Amount is the posted invoice total; a sale return reduces the executive on its original invoice. Amount Received counts posted CRV and BRV receipts that name the executive.",
      "Total is the executive's running sales less receipts within the selected dates, and each executive heading shows their period totals. Select an executive on screen to collapse or expand their rows.",
    ],
  };
}
