import { sql } from "drizzle-orm";
import type { Database, Transaction } from "@/db";
import type { ReportFilter } from "./model";

export type Reader = Database | Transaction;
export type AccountMovement = {
  companyId: string; id: string; code: string; name: string; type: string; control: string | null; liquidity: string | null;
  group: string | null; label: string | null; otherExpense: boolean; openingDr: string; openingCr: string; periodDr: string; periodCr: string;
};

export function companySql(ids: string[]) {
  return sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
}

export function effective(ids: string[], cutoff?: string) {
  const companies = companySql(ids);
  if (!cutoff) return sql`
    SELECT e.id,e.document_id,e.company_id,e.accounting_date,e.number,e.reference,e.type,e.narration,e.created_at
    FROM effective_vouchers e WHERE e.company_id IN (${companies})`;
  return sql`
    SELECT v.id,t.document_id,t.company_id,t.accounting_date,t.number,t.reference,t.type,v.narration,d.created_at
    FROM (
      SELECT DISTINCT ON (r.company_id,r.document_id) r.*
      FROM voucher_timeline r WHERE r.company_id IN (${companies}) AND r.recorded_at<=${cutoff}::timestamptz
      ORDER BY r.company_id,r.document_id,r.recorded_at DESC,r.version DESC
    ) t JOIN vouchers v ON v.company_id=t.company_id AND v.id=t.voucher_id
      JOIN voucher_documents d ON d.company_id=t.company_id AND d.id=t.document_id
    WHERE t.status='posted'
    UNION ALL
    SELECT v.id,v.id,v.company_id,v.accounting_date,v.number,'' AS reference,v.type,v.narration,v.created_at
    FROM vouchers v LEFT JOIN voucher_versions w ON w.company_id=v.company_id AND w.voucher_id=v.id
    WHERE v.company_id IN (${companies}) AND v.status='posted' AND v.posted_at<=${cutoff}::timestamptz
      AND (w.voucher_id IS NULL OR (w.document_id=v.id AND NOT EXISTS(
        SELECT 1 FROM voucher_timeline x WHERE x.company_id=v.company_id AND x.document_id=w.document_id AND x.recorded_at<=${cutoff}::timestamptz
      )))`;
}

function invoiceJoin(historical?: string) {
  if (!historical) return sql`LEFT JOIN invoices i ON i.company_id=v.company_id AND i.voucher_id=v.id`;
  return sql`
    LEFT JOIN voucher_documents source ON source.company_id=v.company_id AND source.id=v.document_id AND source.source='invoice'
    LEFT JOIN LATERAL (
      SELECT invoice.id,coalesce(revision.next_data->>'number',invoice.number) AS number,
        coalesce((revision.next_data->>'partyId')::uuid,invoice.party_id) AS party_id
      FROM invoices invoice
      LEFT JOIN LATERAL (
        SELECT r.next_data FROM transaction_revisions r
        WHERE r.company_id=invoice.company_id AND r.entity_type='invoice' AND r.entity_id=invoice.id
          AND r.next_data->>'voucherId'=v.id::text AND r.created_at<=${historical}::timestamptz
        ORDER BY r.version DESC LIMIT 1
      ) revision ON true
      WHERE invoice.company_id=source.company_id AND invoice.id=source.source_id
    ) i ON true`;
}

function conditions(filter: ReportFilter) {
  return sql`
    (${filter.voucherType ?? ""}='' OR v.type::text=${filter.voucherType ?? ""})
    AND (${filter.voucher ?? ""}='' OR strpos(lower(v.number),lower(${filter.voucher ?? ""}))>0 OR v.document_id::text=${filter.voucher ?? ""})
    AND (${filter.invoice ?? ""}='' OR strpos(lower(coalesce(i.number,'')),lower(${filter.invoice ?? ""}))>0 OR i.id::text=${filter.invoice ?? ""})
    AND (${filter.party ?? null}::uuid IS NULL OR l.party_id=${filter.party ?? null}::uuid OR i.party_id=${filter.party ?? null}::uuid)
    AND (${filter.search}='' OR strpos(lower(concat_ws(' ',v.number,v.narration,v.reference,l.description,i.number,p.name)),lower(${filter.search}))>0)`;
}

function accountConditions(filter: ReportFilter) {
  return sql`
    (${filter.account ?? null}::uuid IS NULL OR a.id=${filter.account ?? null}::uuid)
    AND (${filter.main ?? null}::uuid IS NULL OR EXISTS (SELECT 1 FROM tree WHERE tree.company_id=a.company_id AND tree.id=a.id))
    AND (${filter.classification ?? ""}='' OR a.type::text=${filter.classification ?? ""})
    AND (${filter.group ?? ""}='' OR m.group_key=${filter.group ?? ""})`;
}

function mainTree(ids: string[], main?: string) {
  return sql`
    tree AS (
      SELECT a.company_id,a.id FROM accounts a WHERE a.company_id IN (${companySql(ids)}) AND a.id=${main ?? null}::uuid
      UNION
      SELECT a.company_id,a.id FROM accounts a JOIN tree t ON a.company_id=t.company_id AND a.parent_id=t.id
    )`;
}

export async function movements(db: Reader, ids: string[], filter: ReportFilter) {
  return (await db.execute<AccountMovement>(sql`
    WITH RECURSIVE ${mainTree(ids,filter.main)}, e AS (${effective(ids,filter.recordedAt)}), rollup AS (
      SELECT l.company_id,l.account_id,
        coalesce(sum(l.debit) FILTER(WHERE v.accounting_date<${filter.from}::date),0) AS opening_dr,
        coalesce(sum(l.credit) FILTER(WHERE v.accounting_date<${filter.from}::date),0) AS opening_cr,
        coalesce(sum(l.debit) FILTER(WHERE v.accounting_date>=${filter.from}::date),0) AS period_dr,
        coalesce(sum(l.credit) FILTER(WHERE v.accounting_date>=${filter.from}::date),0) AS period_cr
      FROM e v JOIN journal_lines l ON l.company_id=v.company_id AND l.voucher_id=v.id
      ${invoiceJoin(filter.recordedAt)}
      LEFT JOIN parties p ON p.company_id=l.company_id AND p.id=coalesce(l.party_id,i.party_id)
      WHERE v.accounting_date<=${filter.to}::date AND ${conditions(filter)}
      GROUP BY l.company_id,l.account_id
    )
    SELECT a.company_id AS "companyId",a.id,a.code,a.name,a.type,a.control,a.liquidity,
      CASE WHEN m.type=a.type THEN m.group_key ELSE null END AS "group",
      CASE WHEN m.type=a.type THEN m.label ELSE null END AS label,coalesce(m.other_expense,false) AS "otherExpense",
      coalesce(r.opening_dr,0)::text AS "openingDr",coalesce(r.opening_cr,0)::text AS "openingCr",
      coalesce(r.period_dr,0)::text AS "periodDr",coalesce(r.period_cr,0)::text AS "periodCr"
    FROM accounts a LEFT JOIN rollup r ON r.company_id=a.company_id AND r.account_id=a.id
    LEFT JOIN report_account_mappings m ON m.company_id=a.company_id AND m.account_id=a.id
    WHERE a.company_id IN (${companySql(ids)}) AND ${accountConditions(filter)}
    ORDER BY a.company_id,a.code,a.id
  `)).rows;
}

export type Detail = {
  id: string; companyId: string; documentId: string; day: string; number: string; type: string; invoice: string | null;
  accountId: string; account: string; party: string | null; narration: string; debit: string; credit: string;
  running: string; partyRunning: string; status: string; reference: string;
  /** Invoice line types behind an invoice journal line, comma separated. Null outside posted invoices. */
  lineType: string | null;
};

export async function detail(db: Reader, ids: string[], f: ReportFilter, liquidity = false, partyOnly = false) {
  const modeCondition = liquidity ? sql`a.liquidity IS NOT NULL` : sql`true`;
  const rows = (await db.execute<Detail>(sql`
    WITH RECURSIVE ${mainTree(ids,f.main)}, e AS (${effective(ids,f.recordedAt)}), book AS (
      SELECT l.id,l.company_id,l.voucher_id,l.account_id,l.party_id,l.item_id,l.description,l.debit,l.credit,l.line_no,
        sum(l.debit-l.credit) OVER (PARTITION BY l.company_id,l.account_id ORDER BY v.accounting_date,v.created_at,v.document_id,l.line_no,l.id) AS running,
        sum(l.debit-l.credit) OVER (PARTITION BY l.company_id,l.party_id ORDER BY v.accounting_date,v.created_at,v.document_id,l.line_no,l.id) AS party_running
      FROM e v JOIN journal_lines l ON l.company_id=v.company_id AND l.voucher_id=v.id WHERE v.accounting_date<=${f.to}::date
    )
    SELECT l.id,l.company_id AS "companyId",v.document_id AS "documentId",v.accounting_date::text AS day,v.number,v.type,i.number AS invoice,
      a.id AS "accountId",a.code||' · '||a.name AS account,p.name AS party,coalesce(nullif(l.description,''),v.narration) AS narration,
      l.debit::text,l.credit::text,l.running::text,l.party_running::text AS "partyRunning",'posted' AS status,v.reference,
      (SELECT string_agg(DISTINCT x.line_type,', ') FROM invoice_lines x WHERE x.company_id=l.company_id AND x.posting_voucher_id=l.voucher_id
        AND (l.item_id IS NULL OR x.item_id=l.item_id)) AS "lineType"
    FROM book l JOIN e v ON v.company_id=l.company_id AND v.id=l.voucher_id
    JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id
    LEFT JOIN report_account_mappings m ON m.company_id=a.company_id AND m.account_id=a.id
    ${invoiceJoin(f.recordedAt)}
    LEFT JOIN parties p ON p.company_id=l.company_id AND p.id=coalesce(l.party_id,i.party_id)
    WHERE v.accounting_date BETWEEN ${f.from}::date AND ${f.to}::date AND ${conditions(f)}
      AND ${accountConditions(f)} AND ${modeCondition} AND (${!partyOnly} OR l.party_id=${f.party ?? null}::uuid)
    ORDER BY v.accounting_date,v.created_at,v.company_id,v.document_id,l.line_no,l.id
  `)).rows;
  return rows;
}

export async function inactiveDetail(db: Reader, ids: string[], f: ReportFilter) {
  const state = f.recordedAt ? sql`
    SELECT DISTINCT ON (company_id,document_id) company_id,document_id AS id,voucher_id AS current_voucher_id,
      accounting_date,number,reference,status,type,draft,recorded_at AS ordered
    FROM voucher_timeline WHERE company_id IN (${companySql(ids)}) AND recorded_at<=${f.recordedAt}::timestamptz
    ORDER BY company_id,document_id,recorded_at DESC,version DESC`
    : sql`SELECT company_id,id,current_voucher_id,accounting_date,number,reference,status,type,draft,created_at AS ordered
      FROM voucher_documents WHERE company_id IN (${companySql(ids)})`;
  return (await db.execute<Detail>(sql`
    WITH RECURSIVE ${mainTree(ids,f.main)}, states AS (${state})
    SELECT coalesce(l.id::text,d.id::text||':'||q.ordinality::text,d.id::text) AS id,
      d.company_id AS "companyId",d.id AS "documentId",d.accounting_date::text AS day,coalesce(d.number,'Unnumbered') AS number,
      d.type,i.number AS invoice,a.id AS "accountId",concat_ws(' · ',a.code,a.name) AS account,p.name AS party,
      coalesce(nullif(l.description,''),q.entry->>'description',d.draft#>>'{entry,narration}',v.narration,'') AS narration,
      coalesce(l.debit::text,q.entry->>'debit','0') AS debit,coalesce(l.credit::text,q.entry->>'credit','0') AS credit,
      '0' AS running,'0' AS "partyRunning",d.status::text,d.reference,NULL::text AS "lineType"
    FROM states d LEFT JOIN vouchers v ON v.company_id=d.company_id AND v.id=d.current_voucher_id
    LEFT JOIN journal_lines l ON l.company_id=v.company_id AND l.voucher_id=v.id
    LEFT JOIN LATERAL jsonb_array_elements(CASE WHEN d.current_voucher_id IS NULL AND jsonb_typeof(d.draft#>'{entry,lines}')='array'
      THEN d.draft#>'{entry,lines}' ELSE '[]'::jsonb END) WITH ORDINALITY q(entry,ordinality) ON true
    LEFT JOIN accounts a ON a.company_id=d.company_id AND a.id=coalesce(l.account_id,(q.entry->>'accountId')::uuid)
    LEFT JOIN report_account_mappings m ON m.company_id=a.company_id AND m.account_id=a.id
    LEFT JOIN voucher_documents source ON source.company_id=d.company_id AND source.id=d.id AND source.source='invoice'
    LEFT JOIN invoices i ON i.company_id=source.company_id AND i.id=source.source_id
    LEFT JOIN parties p ON p.company_id=d.company_id AND p.id=coalesce(l.party_id,(q.entry->>'partyId')::uuid,i.party_id)
    WHERE d.status<>'posted' AND (${f.status}='all' OR d.status::text=${f.status})
      AND d.accounting_date BETWEEN ${f.from}::date AND ${f.to}::date
      AND (${f.voucherType ?? ""}='' OR d.type::text=${f.voucherType ?? ""})
      AND (${f.voucher ?? ""}='' OR strpos(lower(coalesce(d.number,'')),lower(${f.voucher ?? ""}))>0 OR d.id::text=${f.voucher ?? ""})
      AND (${f.invoice ?? ""}='' OR strpos(lower(coalesce(i.number,'')),lower(${f.invoice ?? ""}))>0)
      AND (${f.party ?? null}::uuid IS NULL OR p.id=${f.party ?? null}::uuid)
      AND (${f.search}='' OR strpos(lower(concat_ws(' ',d.number,d.reference,d.draft#>>'{entry,narration}',v.narration,p.name)),lower(${f.search}))>0)
      AND ${accountConditions(f)}
    ORDER BY d.accounting_date,d.ordered,d.company_id,d.id,coalesce(l.line_no,q.ordinality,0)
  `)).rows;
}
