import Link from "next/link";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { PageHeading } from "./finance-ui";
import { AccFilters, AccTable } from "./acc-ui";
import type { Screen } from "./index-views";
import { first, resolveRange } from "@/lib/range";
import { displayDate } from "@/lib/validation";

export async function LegacyRepairs({ companyId, companyName, base, query }: Screen) {
  const { from, to } = resolveRange(query);
  const q = (first(query.q) ?? "").trim().slice(0, 100);
  const rows = await getDb().execute<{ id: string; number: string; date: string; narration: string; count: string }>(sql`
    SELECT v.id, v.number, v.accounting_date::text AS date, v.narration, count(*)::text
    FROM effective_vouchers v JOIN journal_lines l ON l.company_id=v.company_id AND l.voucher_id=v.id AND l.party_id IS NULL
    JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id AND a.control IN ('receivable','payable')
    LEFT JOIN voucher_versions vv ON vv.company_id=v.company_id AND vv.voucher_id=v.id
    WHERE v.company_id=${companyId} AND v.type IN ('JV','VR','CPV','CRV','BPV','BRV') AND vv.voucher_id IS NULL
      AND v.accounting_date BETWEEN ${from}::date AND ${to}::date AND (${q}='' OR strpos(lower(concat_ws(' ',v.number,v.narration)),lower(${q}))>0)
      AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.company_id=v.company_id AND i.voucher_id=v.id)
      AND NOT EXISTS (SELECT 1 FROM inventory_adjustments i WHERE i.company_id=v.company_id AND i.voucher_id=v.id)
    GROUP BY v.id,v.number,v.accounting_date,v.narration ORDER BY v.accounting_date DESC,v.number LIMIT 100
  `);
  return <>
    <PageHeading title="Link existing party vouchers" company={companyName} subtitle="Older vouchers whose receivable or payable lines have no party yet" />
    <AccFilters query={query} withSearch dateLabel="Original voucher date" />
    <AccTable title="Unlinked control-account vouchers" subtitle="Open a voucher to confirm the party for each line"
      headers={["Voucher","Date","Narration",{ label: "Unlinked lines", num: true }]}
      empty={!rows.rows.length ? "No unlinked vouchers match your filters" : undefined}>
      {rows.rows.map((row) => <tr key={row.id}><td><Link className="acc-strong-link" href={`${base}/vouchers/${row.id}`}>{row.number}</Link></td>
        <td className="acc-nowrap">{displayDate(row.date)}</td><td className="acc-narration"><span>{row.narration || "—"}</span></td>
        <td className="acc-num"><span className="status acc-status-draft">{row.count}</span></td></tr>)}
    </AccTable>
  </>;
}
