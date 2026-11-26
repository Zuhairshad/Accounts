import { sql } from "drizzle-orm";
import { displayDate } from "@/lib/validation";
import { Exact } from "@/lib/engine/model";
import { invoiceOutstanding } from "@/lib/engine/settlement";
import { inventorySummary, stockLedger } from "@/lib/trade/read";
import { companySql, effective, type Reader } from "./journal";
import { dateCell, integerCell, moneyCell, quantityCell, sum, textCell, type Cell, type ReportDocument, type ReportFilter, type ReportId, type ReportRow } from "./model";

type Parts = Pick<ReportDocument,"columns"|"rows"|"notes"|"warning">;
type Named = { id:string; name:string };
const match = (value: string, wanted: string) => !wanted || value.toLowerCase().includes(wanted.toLowerCase());
const bill = (company:string,id:string) => `/workspace/${company}/trade/invoices/${id}`;
const voucher = (company:string,id:string) => `/workspace/${company}/accounting/vouchers/${id}`;
const ledger = (company:string,id:string,f:ReportFilter) => `/workspace/${company}/reports/party-ledger?${new URLSearchParams({party:id,from:f.from,to:f.to})}`;

export type TradeRow = {
  id:string; companyId:string; day:string; number:string; voucher:string; documentId:string; type:string; party:string;
  narration:string; external:string; total:string; tax:string; net:string; postedAt:Date;
};

export async function tradeRows(db:Reader,ids:string[],f:ReportFilter,types?:string[]) {
  const marks = types?.length ? sql`AND i.type::text IN (${sql.join(types.map((type)=>sql`${type}`),sql`, `)})` : sql``;
  return (await db.execute<TradeRow>(sql`
    SELECT i.id,i.company_id AS "companyId",i.accounting_date::text AS day,i.number,e.number AS voucher,e.document_id AS "documentId",
      i.type,p.name AS party,e.narration,i.external_ref AS external,i.total::text,coalesce(i.calculation->>'tax','0') AS tax,
      (i.total-coalesce((i.calculation->>'tax')::numeric,0))::text AS net,e.created_at AS "postedAt"
    FROM invoices i JOIN effective_vouchers e ON e.company_id=i.company_id AND e.id=i.voucher_id
    JOIN parties p ON p.company_id=i.company_id AND p.id=i.party_id
    WHERE i.company_id IN (${companySql(ids)}) AND i.status='posted' ${marks}
      AND i.accounting_date BETWEEN ${f.from}::date AND ${f.to}::date
      AND (${f.party ?? null}::uuid IS NULL OR i.party_id=${f.party ?? null}::uuid)
      AND (${f.voucher ?? ""}='' OR strpos(lower(e.number),lower(${f.voucher ?? ""}))>0)
      AND (${f.invoice ?? ""}='' OR strpos(lower(i.number),lower(${f.invoice ?? ""}))>0 OR i.id::text=${f.invoice ?? ""})
      AND (${f.search}='' OR strpos(lower(concat_ws(' ',i.number,e.number,i.external_ref,i.po_ref,p.name,e.narration)),lower(${f.search}))>0)
    ORDER BY i.accounting_date,e.created_at,i.company_id,i.id
  `)).rows;
}

export async function invoiceReport(db:Reader,id:string,f:ReportFilter,kind:ReportId):Promise<Parts> {
  const types = ({
    sales:["sale","sale_return"],purchases:["purchase","purchase_return"],"sales-returns":["sale_return"],"purchase-returns":["purchase_return"],
  } as Record<string,string[]>)[kind];
  const data = await tradeRows(db,[id],f,types);
  const amount = (row: TradeRow,value:string) => new Exact(value).times(row.type.endsWith("_return") ? -1 : 1);
  const columns = ["Date","Invoice number","Voucher number","Type","Party","External reference","Net before tax","Tax","Total (PKR)"];
  const rows:ReportRow[] = data.map((row)=>({key:row.id,cells:[
    dateCell(row.day),textCell(row.number,bill(id,row.id)),textCell(row.voucher,voucher(id,row.documentId)),textCell(row.type.replaceAll("_"," ")),
    textCell(row.party),textCell(row.external),moneyCell(amount(row,row.net),bill(id,row.id)),moneyCell(amount(row,row.tax),bill(id,row.id)),moneyCell(amount(row,row.total),bill(id,row.id)),
  ]}));
  if (data.length) rows.push({key:"total",style:"total",cells:[textCell("Net totals"),...Array<Cell>(5).fill(textCell("")),
    moneyCell(sum(data,(r)=>amount(r,r.net))),moneyCell(sum(data,(r)=>amount(r,r.tax))),moneyCell(sum(data,(r)=>amount(r,r.total)))]});
  return {columns,rows,notes:["One row per effective invoice. Returns reduce the relevant total. Net before tax excludes entered invoice tax."]};
}

export async function voucherReport(db:Reader,id:string,f:ReportFilter):Promise<Parts> {
  const data = (await db.execute<{id:string;day:string;number:string;type:string;narration:string;reference:string;dr:string;cr:string}>(sql`
    WITH e AS (${effective([id],f.recordedAt)})
    SELECT e.document_id AS id,e.accounting_date::text AS day,e.number,e.type,e.narration,e.reference,
      coalesce(sum(l.debit),0)::text AS dr,coalesce(sum(l.credit),0)::text AS cr
    FROM e LEFT JOIN journal_lines l ON l.company_id=e.company_id AND l.voucher_id=e.id
    WHERE e.accounting_date BETWEEN ${f.from}::date AND ${f.to}::date
      AND (${f.voucherType ?? ""}='' OR e.type::text=${f.voucherType ?? ""})
      AND (${f.voucher ?? ""}='' OR strpos(lower(e.number),lower(${f.voucher ?? ""}))>0 OR e.document_id::text=${f.voucher ?? ""})
      AND (${f.search}='' OR strpos(lower(concat_ws(' ',e.number,e.narration,e.reference)),lower(${f.search}))>0)
    GROUP BY e.document_id,e.accounting_date,e.number,e.type,e.narration,e.reference,e.created_at
    ORDER BY e.accounting_date,e.created_at,e.document_id
  `)).rows;
  const rows:ReportRow[] = data.map((row)=>({key:row.id,cells:[dateCell(row.day),textCell(row.number,voucher(id,row.id)),textCell(row.type),
    textCell(row.reference),textCell(row.narration),moneyCell(row.dr,voucher(id,row.id)),moneyCell(row.cr,voucher(id,row.id))]}));
  if (data.length) rows.push({key:"total",style:"total",cells:[textCell("Total"),...Array<Cell>(4).fill(textCell("")),moneyCell(sum(data,(r)=>r.dr)),moneyCell(sum(data,(r)=>r.cr))]});
  return {columns:["Date","Voucher Number","Voucher Type","Reference","Narration","Debit","Credit"],rows,notes:[]};
}

export async function partiesReport(db:Reader,companies:Named[],f:ReportFilter,kind:ReportId):Promise<Parts> {
  const combined = kind==="combined-parties";
  const roles = kind==="debtors" ? "customer" : kind==="creditors" ? "supplier" : "";
  const data = (await db.execute<{id:string;companyId:string;name:string;type:string;opening:string;dr:string;cr:string;balance:string}>(sql`
    WITH ledger AS (
      SELECT l.company_id,l.party_id,sum(l.debit-l.credit) FILTER (WHERE v.accounting_date<${f.from}::date) AS opening,
        sum(l.debit) FILTER (WHERE v.accounting_date>=${f.from}::date) AS dr,
        sum(l.credit) FILTER (WHERE v.accounting_date>=${f.from}::date) AS cr,sum(l.debit-l.credit) AS balance
      FROM effective_vouchers v JOIN journal_lines l ON v.company_id=l.company_id AND v.id=l.voucher_id
      WHERE v.company_id IN (${companySql(companies.map((c)=>c.id))}) AND v.accounting_date<=${f.to}::date AND l.party_id IS NOT NULL
      GROUP BY l.company_id,l.party_id
    )
    SELECT p.id,p.company_id AS "companyId",p.name,p.type,coalesce(l.opening,0)::text AS opening,
      coalesce(l.dr,0)::text AS dr,coalesce(l.cr,0)::text AS cr,l.balance::text
    FROM parties p JOIN ledger l ON l.company_id=p.company_id AND l.party_id=p.id
    WHERE (${roles}='' OR p.type::text=${roles}) AND (l.balance<>0 OR coalesce(l.dr,0)<>0 OR coalesce(l.cr,0)<>0)
      AND (${f.party ?? null}::uuid IS NULL OR p.id=${f.party ?? null}::uuid)
    ORDER BY p.company_id,p.type,p.name,p.id
  `)).rows.filter((r)=>match(r.name,f.search));
  const sections:ReportRow[] = [];
  const aggregate = (records: typeof data,key:string):ReportRow => {
    const owed = (r:typeof data[number]) => new Exact(r.balance).times(r.type==="customer" ? 1 : -1);
    return { key,style:"total",cells:[textCell(key),textCell(""),moneyCell(sum(records,(r)=>r.opening)),moneyCell(sum(records,(r)=>r.dr)),
      moneyCell(sum(records,(r)=>r.cr)),moneyCell(sum(records,(r)=>r.balance)),moneyCell(sum(records.filter((r)=>r.type==="customer"),(r)=>Exact.max(owed(r),0))),
      moneyCell(sum(records.filter((r)=>r.type==="supplier"),(r)=>Exact.max(owed(r),0))),moneyCell(sum(records.filter((r)=>r.type==="customer"),(r)=>Exact.max(owed(r).negated(),0))),
      moneyCell(sum(records.filter((r)=>r.type==="supplier"),(r)=>Exact.max(owed(r).negated(),0)))] };
  };
  for (const company of companies) {
    const rows = data.filter((r)=>r.companyId===company.id);
    if (combined) sections.push({key:company.id,style:"section",cells:[textCell(company.name)]});
    for (const row of rows) {
      const sign = new Exact(row.balance).times(row.type==="customer" ? 1 : -1);
      const href = ledger(company.id,row.id,f);
      sections.push({key:row.id,cells:[textCell(row.name,href),textCell(row.type),moneyCell(row.opening,href),moneyCell(row.dr,href),
        moneyCell(row.cr,href),moneyCell(row.balance,href),moneyCell(row.type==="customer" ? Exact.max(sign,0):"0",href),
        moneyCell(row.type==="supplier" ? Exact.max(sign,0):"0",href),moneyCell(row.type==="customer" ? Exact.max(sign.negated(),0):"0",href),
        moneyCell(row.type==="supplier" ? Exact.max(sign.negated(),0):"0",href)]});
    }
    if (combined && rows.length) sections.push(aggregate(rows,`${company.name} subtotal`));
  }
  if (data.length) sections.push(aggregate(data,"Overall total"));
  const diagnostic = (await db.execute<{balance:string;count:string}>(sql`
    SELECT coalesce(sum(l.debit-l.credit),0)::text AS balance,count(*)::text AS count
    FROM effective_vouchers v JOIN journal_lines l ON l.company_id=v.company_id AND l.voucher_id=v.id
    JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id
    WHERE v.company_id IN (${companySql(companies.map((c)=>c.id))}) AND v.accounting_date<=${f.to}::date AND l.party_id IS NULL
      AND (a.control IN ('receivable','payable'))
      AND (${roles}='' OR a.control=CASE WHEN ${roles}='customer' THEN 'receivable' ELSE 'payable' END)
  `)).rows[0];
  return {columns:["Party or subtotal","Type","Opening (Dr – Cr)","Period Dr","Period Cr","Closing (Dr – Cr)","Receivable","Payable","Customer advance","Supplier advance"],
    rows:sections,notes:["Party totals use posted control entries, including advances, openings, payments and returns. Filter by party to drill into individual postings."],
    warning:diagnostic.count==="0" ? undefined : `${diagnostic.count} unlinked control-account lines have net PKR ${diagnostic.balance} as of this date. Review the legacy party-link report to reconcile them.`};
}

export async function agingReport(db:Reader,id:string,f:ReportFilter):Promise<Parts> {
  const data = (await invoiceOutstanding(db,id,f.to,f.party)).filter((row)=>new Exact(row.outstanding).gt(0) &&
    match(`${row.number} ${row.party}`,f.search) && (!f.classification || f.classification===(row.type==="sale" ? "customer" : "supplier")));
  const bucket = (days:number) => days===0 ? "Current" : days<=30 ? "1–30 days" : days<=60 ? "31–60 days" : days<=90 ? "61–90 days" : "Over 90 days";
  const rows:ReportRow[] = data.map((r)=>({key:r.id,cells:[textCell(r.number,bill(id,r.id)),textCell(r.party,ledger(id,r.partyId,f)),
    textCell(r.type),dateCell(r.date),dateCell(r.dueOn),moneyCell(r.invoiceAmount),moneyCell(r.embeddedSettlement),moneyCell(r.creditNotes),
    moneyCell(r.allocated),moneyCell(r.outstanding,bill(id,r.id)),integerCell(r.overdueDays),textCell(bucket(r.overdueDays))]}));
  if (rows.length) rows.push({key:"total",style:"total",cells:[textCell("Outstanding total"),...Array<Cell>(8).fill(textCell("")),moneyCell(sum(data,(r)=>r.outstanding))]});
  return {columns:["Invoice","Party","Type","Invoice date","Due date","Invoice amount","Invoice settlement","Credit notes","Allocated","Outstanding","Days overdue","Age band"],rows,
    notes:[`Outstanding invoices as of ${f.to}. Party totals may include advances and non-invoice transactions.`]};
}

export async function inventoryReport(db:Reader,id:string,f:ReportFilter,kind:ReportId):Promise<Parts> {
  if (kind==="stock-ledger") {
    const columns = ["Date","Voucher","Movement","Qty change","Unit cost","Value change","Running qty","Running value","Average cost"];
    if (!f.item) return {columns,rows:[],notes:["Choose an inventory item."]};
    const rows = (await stockLedger(db,id,f.item,f.from,f.to)).filter((r)=>match(`${r.voucher} ${r.kind}`,f.search))
      .map((r)=>({key:r.id,cells:[dateCell(r.date),textCell(r.voucher,voucher(id,r.documentId)),textCell(r.kind),
        quantityCell(r.qty),quantityCell(r.unitCost),moneyCell(r.value),quantityCell(r.qtyAfter),moneyCell(r.valueAfter),quantityCell(r.average)]}));
    return {columns,rows,notes:[]};
  }
  const data = (await inventorySummary(db,id,f.to,f.item)).filter((row)=>row.kind==="stock" && match(`${row.name} ${row.sku ?? ""}`,f.search));
  const rows:ReportRow[] = data.map((row)=>{
    const href=`/workspace/${id}/reports/stock-ledger?item=${row.id}&from=1900-01-01&to=${f.to}`;
    return {key:row.id,cells:[textCell(row.sku),textCell(row.name,href),textCell(row.unit),quantityCell(row.qty),
      quantityCell(row.average),moneyCell(row.value,href)]};
  });
  const total=sum(data,(row)=>row.value);
  if (rows.length) rows.push({key:"total",style:"total",cells:[textCell("Stock value total"),...Array<Cell>(4).fill(textCell("")),moneyCell(total)]});
  let warning:string|undefined;
  if (!f.item && !f.search) {
    const control=(await db.execute<{id:string;value:string}>(sql`
      SELECT a.id,coalesce(sum(l.debit-l.credit) FILTER(WHERE e.id IS NOT NULL),0)::text AS value
      FROM accounts a
      LEFT JOIN journal_lines l ON l.company_id=a.company_id AND l.account_id=a.id
      LEFT JOIN effective_vouchers e ON e.company_id=l.company_id AND e.id=l.voucher_id AND e.accounting_date<=${f.to}::date
      WHERE a.company_id=${id} AND a.control='inventory' GROUP BY a.id
    `)).rows;
    if (control.length) {
      const href=`/workspace/${id}/reports/general-ledger?account=${control[0].id}&from=1900-01-01&to=${f.to}`;
      const gl=sum(control,(row)=>row.value);
      rows.push({key:"inventory-gl",style:"total",cells:[textCell("Inventory control (GL)",href),...Array<Cell>(4).fill(textCell("")),moneyCell(gl,href)]});
      if (!total.eq(gl)) warning=`Inventory valuation differs from the inventory control account by PKR ${total.minus(gl).abs().toFixed(2)}. Open the inventory control ledger to review journal entries.`;
    }
  }
  return {columns:["SKU","Item","Unit","On hand","Average cost","Stock value (PKR)"],rows,warning,notes:[`Stock values as of ${displayDate(f.to)} include effective movements through that date.`]};
}

export async function adjustmentsReport(db:Reader,id:string,f:ReportFilter):Promise<Parts> {
  const data = (await db.execute<{id:string;day:string;number:string;voucher:string;documentId:string;kind:string;item:string;qty:string;value:string;reason:string}>(sql`
    SELECT a.id,e.accounting_date::text AS day,a.number,e.number AS voucher,e.document_id AS "documentId",a.kind,
      g.name AS item,coalesce(a.calculation->>'difference','0') AS qty,coalesce(a.calculation->>'value','0') AS value,a.reason
    FROM inventory_adjustments a JOIN effective_vouchers e ON e.company_id=a.company_id AND e.id=a.voucher_id
    LEFT JOIN inventory_items g ON g.company_id=a.company_id AND g.id=a.item_id
    WHERE a.company_id=${id} AND a.status='posted' AND e.accounting_date BETWEEN ${f.from}::date AND ${f.to}::date
      AND (${f.item ?? null}::uuid IS NULL OR g.id=${f.item ?? null}::uuid)
      AND (${f.search}='' OR strpos(lower(concat_ws(' ',a.number,e.number,a.reason,g.name)),lower(${f.search}))>0)
    ORDER BY e.accounting_date,e.created_at,a.id
  `)).rows;
  const rows:ReportRow[] = data.map((r)=>({key:r.id,cells:[dateCell(r.day),textCell(r.number,`/workspace/${id}/trade/adjustments/${r.id}`),
    textCell(r.voucher,voucher(id,r.documentId)),textCell(r.item),textCell(r.kind),textCell(r.reason),quantityCell(r.qty),moneyCell(r.value)]}));
  if (rows.length) rows.push({key:"total",style:"total",cells:[textCell("Net value change"),...Array<Cell>(6).fill(textCell("")),moneyCell(sum(data,(r)=>r.value))]});
  return {columns:["Date","Adjustment","Voucher","Item","Type","Reason","Quantity change","Value (PKR)"],rows,notes:[]};
}
