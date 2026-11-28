import Link from "next/link";
import { and, asc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { accounts, companySettings, parties, salesExecutives } from "@/db/schema";
import { saveSalesExecutiveAction } from "@/lib/engine/actions";
import { latestSaleExecutives } from "@/lib/engine/receipts";
import { resolveRange } from "@/lib/range";
import { displayDate, karachiToday } from "@/lib/validation";
import { Button } from "../ui/button";
import { FinanceForm } from "./finance-form";
import { DateFilters, Money, PageHeading, PanelTable } from "./finance-ui";
import { ReceiptForm } from "./receipt-form";
import type { Screen } from "./index-views";

const has = (screen: Screen, permission: Screen["permissions"][number]) => screen.permissions.includes(permission);

function ExecutiveFields({ executive }: { executive?: typeof salesExecutives.$inferSelect }) {
  return <div className="form-grid">
    <label className="field">Sales executive name<input name="name" defaultValue={executive?.name} required maxLength={120} /></label>
    <label className="field">Phone<input name="phone" type="tel" defaultValue={executive?.phone} maxLength={60} /></label>
    <label className="field">Status<select name="active" defaultValue={String(executive?.active ?? true)}>
      <option value="true">Active</option><option value="false">Inactive</option></select></label>
  </div>;
}

export async function SalesExecutiveIndex(screen: Screen) {
  const { companyId, companyName, base } = screen;
  const db = getDb();
  const [rows, usage] = await Promise.all([
    db.select().from(salesExecutives).where(eq(salesExecutives.companyId, companyId)).orderBy(asc(salesExecutives.name)),
    db.execute<{ id: string; sales: string; receipts: string }>(sql`
      SELECT x.id,
        (SELECT count(*) FROM invoices i WHERE i.company_id=x.company_id AND i.sales_executive_id=x.id AND i.status='posted')::text AS sales,
        (SELECT count(*) FROM voucher_documents d WHERE d.company_id=x.company_id AND d.sales_executive_id=x.id AND d.status='posted')::text AS receipts
      FROM sales_executives x WHERE x.company_id=${companyId}
    `),
  ]);
  const counts = new Map(usage.rows.map((row) => [row.id, row]));
  return <>
    <PageHeading title="Sales executives" company={companyName} toolbar={<>
      <Button asChild variant="outline"><Link href={`${base}/receipts`}>Payment received</Link></Button>
      <Button asChild variant="outline"><Link href={`/workspace/${companyId}/reports/sales-executives`}>Sales Executive wise Sale Report</Link></Button>
    </>} />
    {has(screen, "create") && <section className="panel"><h2>Add sales executive</h2>
      <p className="muted mt-2">Active executives can be chosen on sale invoices and receipts. Deactivate an executive instead of deleting them so their history stays reported.</p>
      <div className="mt-4"><FinanceForm action={saveSalesExecutiveAction} companyId={companyId} version={0} submit={[{ label: "Add sales executive" }]}>
        <ExecutiveFields />
      </FinanceForm></div>
    </section>}
    <PanelTable title="Sales executive list" headers={["Name","Phone","Status","Posted sales","Posted receipts","Change"]}
      empty={!rows.length ? "No sales executives have been added" : undefined}>
      {rows.map((row) => <tr key={row.id}><td>{row.name}</td><td>{row.phone || "—"}</td>
        <td><span className={`tag ${row.active ? "tag-active" : ""}`}>{row.active ? "Active" : "Inactive"}</span></td>
        <td>{counts.get(row.id)?.sales ?? "0"}</td><td>{counts.get(row.id)?.receipts ?? "0"}</td>
        <td>{has(screen, "edit") ? <details><summary className="text-link cursor-pointer">Edit {row.name}</summary>
          <div className="mt-3"><FinanceForm action={saveSalesExecutiveAction} companyId={companyId} id={row.id} version={row.version}
            submit={[{ label: "Save sales executive" }]}><ExecutiveFields executive={row} /></FinanceForm></div>
        </details> : "—"}</td></tr>)}
    </PanelTable>
  </>;
}

export async function ReceiptEntry(screen: Screen) {
  const { companyId, companyName, base, query } = screen;
  const db = getDb();
  const range = resolveRange(query);
  const [customers, cash, executives, defaults, [settings], recent] = await Promise.all([
    db.select({ id: parties.id, name: parties.name }).from(parties)
      .where(and(eq(parties.companyId, companyId), eq(parties.type, "customer"), eq(parties.active, true))).orderBy(asc(parties.name)),
    db.select({ id: accounts.id, name: accounts.name, liquidity: accounts.liquidity }).from(accounts)
      .where(and(eq(accounts.companyId, companyId), eq(accounts.active, true), sql`${accounts.liquidity} IS NOT NULL`)).orderBy(asc(accounts.code)),
    db.select({ id: salesExecutives.id, name: salesExecutives.name }).from(salesExecutives)
      .where(and(eq(salesExecutives.companyId, companyId), eq(salesExecutives.active, true))).orderBy(asc(salesExecutives.name)),
    latestSaleExecutives(db, companyId),
    db.select().from(companySettings).where(eq(companySettings.companyId, companyId)),
    db.execute<{ id: string; date: string; number: string; type: string; party: string; amount: string; executive: string | null }>(sql`
      SELECT e.document_id AS id,e.accounting_date::text AS date,e.number,e.type,string_agg(DISTINCT p.name,', ') AS party,
        coalesce(sum(l.credit-l.debit) FILTER (WHERE l.party_id IS NOT NULL),0)::text AS amount,x.name AS executive
      FROM effective_vouchers e JOIN voucher_documents d ON d.company_id=e.company_id AND d.id=e.document_id
      JOIN journal_lines l ON l.company_id=e.company_id AND l.voucher_id=e.id
      LEFT JOIN parties p ON p.company_id=l.company_id AND p.id=l.party_id
      LEFT JOIN sales_executives x ON x.company_id=d.company_id AND x.id=d.sales_executive_id
      WHERE e.company_id=${companyId} AND e.type IN ('CRV','BRV') AND e.accounting_date BETWEEN ${range.from}::date AND ${range.to}::date
      GROUP BY e.document_id,e.accounting_date,e.number,e.type,e.created_at,x.name
      ORDER BY e.accounting_date DESC,e.created_at DESC LIMIT 200
    `),
  ]);
  const canRecord = has(screen, "create") && (settings.voucherApproval || has(screen, "post"));
  return <>
    <PageHeading title="Payment received" company={companyName} toolbar={<>
      <Button asChild variant="outline"><Link href={`${base}/sales-executives`}>Sales executives</Link></Button>
      <Button asChild variant="outline"><Link href={`${base}/vouchers?type=CRV`}>Voucher register</Link></Button>
    </>} />
    {canRecord ? <section className="panel"><h2>Record amount received</h2>
      <p className="muted mt-2">A cash account posts a CRV and a bank account posts a BRV, crediting the customer&apos;s balance.
        {settings.voucherApproval ? " Approval is enabled, so the receipt is submitted for a different user to post." : ""}</p>
      <div className="mt-4"><ReceiptForm companyId={companyId} base={base} customers={customers} executives={executives} defaults={defaults}
        accounts={cash.map((row) => ({ ...row, liquidity: row.liquidity! }))} today={karachiToday()} approval={settings.voucherApproval} /></div>
    </section> : <p className="muted">Recording receipts requires create and post permission.</p>}
    <DateFilters query={query} />
    <PanelTable title="Posted receipts" headers={["Date","Voucher","Type","Customer","Amount (PKR)","Sales executive"]}
      empty={!recent.rows.length ? "No posted CRV or BRV receipts in this period" : undefined}>
      {recent.rows.map((row) => <tr key={row.id}><td>{displayDate(row.date)}</td>
        <td><Link className="text-link" href={`${base}/vouchers/${row.id}`}>{row.number}</Link></td><td>{row.type}</td>
        <td>{row.party || "—"}</td><Money value={row.amount} /><td>{row.executive ?? "—"}</td></tr>)}
    </PanelTable>
  </>;
}
