import Link from "next/link";
import { BarChart3, HandCoins, Lock, ReceiptText, UserPlus, UserRound } from "lucide-react";
import { and, asc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { accounts, companySettings, parties, salesExecutives } from "@/db/schema";
import { saveSalesExecutiveAction } from "@/lib/engine/actions";
import { latestSaleExecutives } from "@/lib/engine/receipts";
import { resolveRange } from "@/lib/range";
import { displayDate, karachiToday } from "@/lib/validation";
import { Button } from "../ui/button";
import { FinanceForm } from "./finance-form";
import { PageHeading } from "./finance-ui";
import { AccCard, AccFilters, AccTable, initials, Num, StatCard, tint, Who } from "./acc-ui";
import { VoucherDoc } from "./index-views";
import { Exact } from "@/lib/engine/model";
import { formatMoney } from "@/lib/display";
import { ReceiptForm } from "./receipt-form";
import type { Screen } from "./index-views";

const has = (screen: Screen, permission: Screen["permissions"][number]) => screen.permissions.includes(permission);

function ExecutiveFields({ executive }: { executive?: typeof salesExecutives.$inferSelect }) {
  return <div className="form-grid acc-form-grid acc-cols-3">
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
  const totals = (key: "sales" | "receipts") => usage.rows.reduce((sum, row) => sum + Number(row[key]), 0);
  return <>
    <PageHeading title="Sales executives" company={companyName} subtitle="People credited on sale invoices and customer receipts" toolbar={<>
      <Button asChild variant="outline"><Link href={`${base}/receipts`}>Payment received</Link></Button>
      <Button asChild variant="outline"><Link href={`/workspace/${companyId}/reports/sales-executives`}><BarChart3 size={16} /> Sales Executive wise Sale Report</Link></Button>
    </>} />
    <section className="stat-row acc-stat-row" aria-label="Sales executive summary">
      <StatCard icon={<UserRound size={20} />} title="Executives" subtitle={`${rows.filter((row) => row.active).length} active · ${rows.filter((row) => !row.active).length} inactive`} value={rows.length} />
      <StatCard icon={<ReceiptText size={20} />} tone="blue" title="Posted sales" subtitle="Sale invoices with an executive" value={totals("sales")} />
      <StatCard icon={<HandCoins size={20} />} tone="amber" title="Posted receipts" subtitle="Receipts with an executive" value={totals("receipts")} />
    </section>
    {has(screen, "create") && <AccCard title="Add sales executive" icon={<UserPlus size={18} />}
      subtitle="Active executives can be chosen on sale invoices and receipts. Deactivate an executive instead of deleting them so their history stays reported.">
      <FinanceForm action={saveSalesExecutiveAction} companyId={companyId} version={0} submit={[{ label: "Add sales executive" }]} className="acc-inline-form">
        <ExecutiveFields />
      </FinanceForm>
    </AccCard>}
    <AccTable title="Sales executive list" subtitle={`${rows.length} ${rows.length === 1 ? "executive" : "executives"}`}
      headers={["Name","Phone","Status",{ label: "Posted sales", num: true },{ label: "Posted receipts", num: true },"Change"]}
      empty={!rows.length ? "No sales executives have been added" : undefined}>
      {rows.map((row) => <tr key={row.id}><td><div className="who"><span className={`avatar avatar-${tint(row.name)}`} aria-hidden>{initials(row.name)}</span><strong>{row.name}</strong></div></td>
        <td>{row.phone || <span className="muted">—</span>}</td>
        <td><span className={`tag status ${row.active ? "tag-active status-posted" : "acc-status-neutral"}`}>{row.active ? "Active" : "Inactive"}</span></td>
        <td className="acc-num">{counts.get(row.id)?.sales ?? "0"}</td><td className="acc-num">{counts.get(row.id)?.receipts ?? "0"}</td>
        <td>{has(screen, "edit") ? <details className="acc-inline-action acc-wide-action"><summary>Edit {row.name}</summary>
          <FinanceForm action={saveSalesExecutiveAction} companyId={companyId} id={row.id} version={row.version}
            submit={[{ label: "Save sales executive" }]}><ExecutiveFields executive={row} /></FinanceForm>
        </details> : "—"}</td></tr>)}
    </AccTable>
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
  const received = recent.rows.reduce((sum, row) => sum.plus(row.amount), new Exact(0)).toFixed(2);
  return <>
    <PageHeading title="Payment received" company={companyName} subtitle="Record cash or bank receipts from customers" toolbar={<>
      <Button asChild variant="outline"><Link href={`${base}/sales-executives`}>Sales executives</Link></Button>
      <Button asChild variant="outline"><Link href={`${base}/vouchers?type=CRV`}>Voucher register</Link></Button>
    </>} />
    {canRecord ? <AccCard title="Record amount received" icon={<HandCoins size={18} />} subtitle={<>A cash account posts a CRV and a bank account posts a BRV, crediting the customer&apos;s balance.
        {settings.voucherApproval ? " Approval is enabled, so the receipt is submitted for a different user to post." : ""}</>}>
      <ReceiptForm companyId={companyId} base={base} customers={customers} executives={executives} defaults={defaults}
        accounts={cash.map((row) => ({ ...row, liquidity: row.liquidity! }))} today={karachiToday()} approval={settings.voucherApproval} />
    </AccCard> : <div className="table-empty acc-empty"><Lock size={20} aria-hidden /><strong>Recording receipts requires create and post permission.</strong></div>}
    <AccFilters query={query} />
    <AccTable title="Posted receipts" subtitle={<>{recent.rows.length} {recent.rows.length === 1 ? "receipt" : "receipts"} · PKR {formatMoney(received)} received</>}
      headers={["Voucher","Date","Customer",{ label: "Amount (PKR)", num: true },"Sales executive"]}
      empty={!recent.rows.length ? "No posted CRV or BRV receipts in this period" : undefined}>
      {recent.rows.map((row) => <tr key={row.id}>
        <td><VoucherDoc type={row.type} number={row.number} href={`${base}/vouchers/${row.id}`} /></td>
        <td className="acc-nowrap">{displayDate(row.date)}</td>
        <td>{row.party ? <Who name={row.party} /> : <span className="muted">—</span>}</td><Num value={row.amount} strong />
        <td>{row.executive ?? <span className="muted">—</span>}</td></tr>)}
    </AccTable>
  </>;
}
