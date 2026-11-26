import Link from "next/link";
import { Plus } from "lucide-react";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { accounts, companySettings, financialYears, parties, periods } from "@/db/schema";
import { Button } from "../ui/button";
import { DateFilters, Money, PageHeading, PanelTable, sided } from "./finance-ui";
import { FinanceForm } from "./finance-form";
import { configureAccountingAction, periodAction, saveOpeningAction } from "@/lib/engine/actions";
import { openingRows, partyBalances, voucherList } from "@/lib/engine/read";
import { invoiceOutstanding } from "@/lib/engine/settlement";
import { accountDate, Exact, manualTypes } from "@/lib/engine/model";
import { first, resolveRange, type Query } from "@/lib/range";
import type { Permission } from "@/lib/permissions";
import { displayDate, karachiToday } from "@/lib/validation";
import { formatMoney } from "@/lib/display";

export type Screen = { companyId: string; companyName: string; base: string; actorId: string; permissions: Permission[]; query: Query };

const has = (screen: Screen, permission: Permission) => screen.permissions.includes(permission);

export async function VoucherRegister(screen: Screen) {
  const { base, query, companyId, companyName } = screen;
  const parsed = resolveRange(query);
  const type = first(query.type) || undefined;
  const status = first(query.status) || undefined;
  const q = (first(query.q) ?? "").trim().slice(0, 100);
  const page = Math.min(10000, Math.max(1, Number.parseInt(first(query.page) ?? "", 10) || 1));
  const rows = await voucherList(getDb(), companyId, { ...parsed, q, type, status, offset: (page - 1) * 50 });
  const link = (target: number) => `${base}/vouchers?${new URLSearchParams({
    from: parsed.from, to: parsed.to, q, type: type ?? "", status: status ?? "", page: String(target),
  })}`;
  const total = Number(rows[0]?.count ?? 0);
  return <>
    <PageHeading title="Voucher register" company={companyName} toolbar={<>
      <Button asChild variant="outline"><Link href={`${base}/recycle`}>Recycle bin</Link></Button>
      {has(screen, "create") && <Button asChild><a href={`${base}/vouchers/new`}><Plus size={16} /> New voucher</a></Button>}
    </>} />
    <DateFilters query={query} withSearch>
      <label className="field">Voucher type<select name="type" defaultValue={type}>
        <option value="">All types</option>{[...manualTypes,"opening","sale","purchase","sale_return","purchase_return","adjustment","reversal"].map((value) => <option key={value}>{value}</option>)}
      </select></label>
      <label className="field">Status<select name="status" defaultValue={status}><option value="">Draft and posted</option><option value="draft">Draft</option><option value="posted">Posted</option></select></label>
    </DateFilters>
    <PanelTable title="Vouchers" headers={["Date","Voucher","Type","Status","Reference","Narration","Posted amount (PKR)"]} empty={!rows.length ? "No vouchers match your filters" : undefined}>
      {rows.map((row) => <tr key={row.id}><td>{displayDate(row.date)}</td><td><Link className="text-link" href={`${base}/vouchers/${row.id}`}>{row.number || "Open draft"}</Link></td>
        <td>{row.type}</td><td><span className={`tag ${row.status === "posted" ? "tag-active" : ""}`}>{row.status}</span></td><td>{row.reference || "—"}</td><td>{row.narration}</td>
        {row.status === "posted" ? <Money value={row.total} /> : <td>—</td>}</tr>)}
    </PanelTable>
    {(page > 1 || total > page * 50) && <div className="finance-toolbar print-hide">{page > 1 && <Link className="text-link" href={link(page - 1)}>Previous page</Link>}
      <span>Page {page}</span>{total > page * 50 && <Link className="text-link" href={link(page + 1)}>Next page</Link>}</div>}
  </>;
}

export async function ChartIndex(screen: Screen) {
  const { companyId, companyName, base, query } = screen;
  const rows = await getDb().select().from(accounts).where(eq(accounts.companyId, companyId)).orderBy(accounts.code);
  const q = (first(query.q) ?? "").trim().toLowerCase().slice(0, 100);
  const type = first(query.type);
  const filtered = rows.filter((row) => (!q || `${row.code} ${row.name}`.toLowerCase().includes(q)) && (!type || row.type === type));
  return <>
    <PageHeading title="Chart of accounts" company={companyName} toolbar={<>
      <Button asChild variant="outline"><Link href={`${base}/opening`}>Opening balances</Link></Button>
      {has(screen, "create") && <Button asChild><a href={`${base}/chart/new`}><Plus size={16} /> Add account</a></Button>}
    </>} />
    <form className="range-form panel" method="get">
      <label className="field">Search accounts<input name="q" defaultValue={q} maxLength={100} /></label>
      <label className="field">Classification<select name="type" defaultValue={type ?? ""}><option value="">All</option>
        {["asset","liability","equity","income","expense"].map((value) => <option key={value}>{value}</option>)}</select></label>
      <Button type="submit" variant="outline">Apply filters</Button>
    </form>
    <PanelTable title="Account heads" headers={["Code","Account","Classification","Main head","Status","Ledger"]} empty={!filtered.length ? "No accounts match your filters" : undefined}>
      {filtered.map((row) => <tr key={row.id}><td>{row.code}</td><td><Link href={`${base}/chart/${row.id}`} className="text-link">{row.name}</Link>
        {row.control && <span className="tag ml-2">System</span>}</td>
        <td className="capitalize">{row.type}</td><td>{rows.find((parent) => parent.id === row.parentId)?.name ?? "—"}</td>
        <td>{row.active ? "Active" : "Inactive"}</td><td><Link href={`${base}/ledger/${row.id}`} className="text-link">View ledger</Link></td>
      </tr>)}
    </PanelTable>
  </>;
}

export async function PartyIndex(screen: Screen) {
  const { companyId, companyName, base, query } = screen;
  const rows = await partyBalances(getDb(), companyId, karachiToday());
  const q = (first(query.q) ?? "").trim().toLowerCase().slice(0, 100);
  const type = first(query.type);
  const visible = rows.filter((row) => (!q || row.name.toLowerCase().includes(q)) && (!type || row.type === type));
  return <>
    <PageHeading title="Customers and suppliers" company={companyName} toolbar={<>
      <Button asChild variant="outline"><Link href={`${base}/opening`}>Opening balances</Link></Button>
      {has(screen, "create") && <Button asChild><a href={`${base}/parties/new`}><Plus size={16} /> Add party</a></Button>}
    </>} />
    <form className="range-form panel" method="get">
      <label className="field">Search parties<input name="q" defaultValue={q} maxLength={100} /></label>
      <label className="field">Classification<select name="type" defaultValue={type ?? ""}><option value="">All</option><option value="customer">Customer</option><option value="supplier">Supplier</option></select></label>
      <Button variant="outline" type="submit">Apply filters</Button>
    </form>
    <PanelTable title="Party master" headers={["Party","Classification","Status","Current balance (PKR)","Ledger"]} empty={!visible.length ? "No parties match your filters" : undefined}>
      {visible.map((row) => <tr key={row.id}><td><Link className="text-link" href={`${base}/parties/${row.id}`}>{row.name}</Link></td><td className="capitalize">{row.type}</td>
        <td>{row.active ? "Active" : "Inactive"}</td><td className="money-cell">{sided(row.balance)}</td>
        <td><Link className="text-link" href={`${base}/party-ledger/${row.id}`}>View ledger</Link></td></tr>)}
    </PanelTable>
  </>;
}

export async function OpeningIndex(screen: Screen) {
  const { companyId, companyName, base, query } = screen;
  const db = getDb();
  const [heads, partyRows, opening, [settings]] = await Promise.all([
    db.select().from(accounts).where(eq(accounts.companyId, companyId)).orderBy(accounts.code),
    db.select().from(parties).where(eq(parties.companyId, companyId)).orderBy(parties.name),
    openingRows(db, companyId), db.select().from(companySettings).where(eq(companySettings.companyId, companyId)),
  ]);
  const byTarget = new Map(opening.map((row) => [row.targetId, row]));
  const target = first(query.target);
  const today = karachiToday();
  const canPost = has(screen, "post") && (has(screen, "edit") || has(screen, "create"));
  const rows = [
    ...heads.filter((head) => !["receivable","payable"].includes(head.control ?? "") &&
      head.id !== (settings.openingOffsetId ?? heads.find((account) => account.control === "opening_equity")?.id))
      .map((head) => ({ id: head.id, name: `${head.code} · ${head.name}`, active: head.active, type: head.type, kind: "account" as const })),
    ...partyRows.map((party) => ({ id: party.id, name: party.name, active: party.active, type: party.type, kind: "party" as const })),
  ].filter((row) => !target || target === row.id);
  return <>
    <PageHeading title="Opening balances" company={companyName} toolbar={target && <Button asChild variant="outline"><Link href={`${base}/opening`}>All opening balances</Link></Button>} />
    <section className="panel">
      <h2>Accounts and parties</h2>
      <p className="muted mt-2">Select the rows to save together. Enter receivables and payables against their individual parties.</p>
      <FinanceForm action={saveOpeningAction} companyId={companyId} submit={canPost && rows.length ? [{ label: "Save selected opening balances" }] : []}>
        <div className="table-scroll mt-4"><table className="entry-table"><thead><tr><th>Apply</th><th>Account or party</th><th>Opening date</th><th>Direction</th><th>Amount (PKR)</th></tr></thead>
          <tbody>{rows.map((row) => {
            const saved = byTarget.get(row.id);
            return <tr key={row.id}><td>
              <input type="hidden" name={`kind.${row.id}`} value={row.kind} />
              <input type="hidden" name={`version.${row.id}`} value={saved?.version ?? 0} />
              {canPost && <input aria-label={`Select ${row.name}`} type="checkbox" name="selected" value={row.id} defaultChecked={!!target} disabled={!row.active} />}
            </td><td>{row.name}<small className="muted block capitalize">{row.type}{row.active ? "" : " · inactive"}</small></td>
              <td>{canPost ? <input aria-label={`Opening date for ${row.name}`} name={`date.${row.id}`} type="date" defaultValue={saved?.date ?? today} /> : saved ? displayDate(saved.date) : "—"}</td>
              <td>{canPost ? <select aria-label={`Opening direction for ${row.name}`} name={`direction.${row.id}`} defaultValue={saved?.direction ?? (row.type === "supplier" ? "credit" : "debit")}>
                <option value="debit">Debit</option><option value="credit">Credit</option></select> : saved?.direction ?? "—"}</td>
              <td>{canPost ? <input aria-label={`Opening amount for ${row.name}`} name={`amount.${row.id}`} inputMode="decimal" maxLength={21} defaultValue={saved?.amount ?? "0"} /> : saved?.amount ?? "0.00"}</td>
            </tr>;
          })}</tbody></table></div>
        {canPost && rows.length > 0 && <label className="field mt-4">Reason<input name="reason" required minLength={3} maxLength={500} /></label>}
      </FinanceForm>
      {!rows.length && <p className="muted mt-4">There are no opening balance targets in this selection.</p>}
    </section>
  </>;
}

export async function PartyReports(screen: Screen, role: "customer" | "supplier") {
  const { companyId, companyName, base, query } = screen;
  const date = accountDate.safeParse(first(query.asOf));
  const asOf = date.success ? date.data : karachiToday();
  const data = await getDb().transaction(async (tx) => {
    const parties = await partyBalances(tx, companyId, asOf);
    const invoices = await invoiceOutstanding(tx, companyId, asOf);
    const unlinked = await tx.execute<{ balance: string; count: string }>(sql`
      SELECT coalesce(sum(l.debit-l.credit),0)::text AS balance,count(*)::text AS count
      FROM journal_lines l JOIN effective_vouchers v ON v.company_id=l.company_id AND v.id=l.voucher_id
      JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id
      WHERE l.company_id=${companyId} AND v.accounting_date<=${asOf}::date AND l.party_id IS NULL
        AND a.control=${role === "customer" ? "receivable" : "payable"}
    `);
    return { unlinked: unlinked.rows[0], parties: parties.filter((row) => row.type === role && !new Exact(row.balance).isZero()),
      invoices: invoices.filter((row) => row.type === (role === "customer" ? "sale" : "purchase") && new Exact(row.outstanding).gt(0)) };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
  const sign = role === "customer" ? 1 : -1;
  const balances = data.parties.map((row) => new Exact(row.balance).times(sign));
  const owed = balances.reduce((total, value) => total.plus(Exact.max(value, 0)), new Exact(0));
  const advances = balances.reduce((total, value) => total.plus(Exact.max(value.negated(), 0)), new Exact(0));
  return <>
    <PageHeading title={role === "customer" ? "Debtors report" : "Creditors report"} company={companyName} />
    <DateFilters query={query} asOf={asOf} />
    <div className="stats-grid">
      <div className="panel stat"><span className="muted">{role === "customer" ? "Receivables" : "Payables"} (PKR)</span><strong>{formatMoney(owed.toFixed(2))}</strong></div>
      <div className="panel stat"><span className="muted">Advances (PKR)</span><strong>{formatMoney(advances.toFixed(2))}</strong></div>
      <div className="panel stat"><span className="muted">Net party balance (PKR)</span><strong>{sided(owed.minus(advances).times(sign).toFixed(2))}</strong></div>
    </div>
    {data.unlinked.count !== "0" && <div className="setup-callout"><p>
      The control account includes {data.unlinked.count} unlinked journal lines, net {sided(data.unlinked.balance)} PKR.
    </p><Link className="text-link" href={`${base}/repair?from=1900-01-01&to=${asOf}`}>Review legacy party links</Link></div>}
    <PanelTable title="Party balances" headers={["Party","Status","Ledger balance (PKR)"]} empty={!data.parties.length ? "No nonzero party balances as of this date" : undefined}>
      {data.parties.map((row) => <tr key={row.id}><td><Link className="text-link" href={`${base}/party-ledger/${row.id}?from=${asOf.slice(0, 7)}-01&to=${asOf}`}>{row.name}</Link></td>
        <td>{row.active ? "Active" : "Inactive"}</td><td>{sided(row.balance)}</td></tr>)}
    </PanelTable>
    <InvoiceAging rows={data.invoices} />
  </>;
}

export function InvoiceAging({ rows }: { rows: Awaited<ReturnType<typeof invoiceOutstanding>> }) {
  const bucket = (days: number) => days === 0 ? "Current" : days <= 30 ? "1–30 days" : days <= 60 ? "31–60 days" : days <= 90 ? "61–90 days" : "Over 90 days";
  return <PanelTable title="Invoice aging" headers={["Invoice","Party","Invoice date","Due date","Invoice amount","Paid on invoice","Credit notes","Allocated","Outstanding","Days overdue","Age band"]}
    empty={!rows.length ? "No outstanding posted invoices for this selection" : undefined}>
    {rows.map((row) => <tr key={row.id}><td>{row.number}</td><td>{row.party}</td><td>{displayDate(row.date)}</td><td>{displayDate(row.dueOn)}</td>
      <Money value={row.invoiceAmount} /><Money value={row.embeddedSettlement} /><Money value={row.creditNotes} /><Money value={row.allocated} /><Money value={row.outstanding} />
      <td>{row.overdueDays}</td><td>{bucket(row.overdueDays)}</td></tr>)}
  </PanelTable>;
}

export async function Recycling(screen: Screen) {
  const { companyId, companyName, base, query } = screen;
  const range = resolveRange(query);
  const q = (first(query.q) ?? "").trim().slice(0, 100);
  const type = first(query.type) ?? "";
  const user = (first(query.user) ?? "").trim().slice(0, 100);
  const result = await getDb().execute<{
    id: string; type: string; entityType: string; version: number; reason: string; number: string | null; deletedBy: string; date: string;
  }>(sql`
    SELECT v.id,v.type,d.entity_type AS "entityType",v.version,d.reason,v.number,u.display_name AS "deletedBy",
      (d.deleted_at AT TIME ZONE 'Asia/Karachi')::date::text AS date
    FROM deleted_records d JOIN voucher_documents v ON v.company_id=d.company_id AND v.id=d.entity_id AND v.status='void'
    JOIN users u ON u.id=d.deleted_by
    WHERE d.company_id=${companyId} AND NOT EXISTS(SELECT 1 FROM restoration_history r WHERE r.company_id=d.company_id AND r.deletion_id=d.id)
      AND (d.deleted_at AT TIME ZONE 'Asia/Karachi')::date BETWEEN ${range.from}::date AND ${range.to}::date
      AND (${type}='' OR v.type::text=${type})
      AND (${q}='' OR strpos(lower(concat_ws(' ',v.number,v.reference,d.reason)),lower(${q}))>0)
      AND (${user}='' OR strpos(lower(concat_ws(' ',u.display_name,u.username)),lower(${user}))>0)
    ORDER BY d.deleted_at DESC,d.id DESC LIMIT 100
  `);
  return <>
    <PageHeading title="Recycle bin" company={companyName} />
    <DateFilters query={query} withSearch dateLabel="Deletion date">
      <label className="field">Deleted by<input name="user" defaultValue={user} maxLength={100} /></label>
      <label className="field">Type<select name="type" defaultValue={type}><option value="">All types</option>
        {[...manualTypes, "opening"].map((value) => <option key={value}>{value}</option>)}</select></label>
    </DateFilters>
    <PanelTable title="Voided transactions" headers={["Deleted on","Transaction","Type","Deleted by","Reason","Action"]}
      empty={!result.rows.length ? "No voided transactions match your filters" : undefined}>
      {result.rows.map((row) => <tr key={row.id}><td>{displayDate(row.date)}</td><td><Link className="text-link" href={`${base}/vouchers/${row.id}`}>{row.number || "Preview draft"}</Link></td>
        <td>{row.type}</td><td>{row.deletedBy}</td><td>{row.reason}</td><td><Link className="text-link" href={`${base}/vouchers/${row.id}`}>{has(screen, "restore") ? "Preview and restore" : "Preview"}</Link></td></tr>)}
    </PanelTable>
  </>;
}

export async function AccountingSettings(screen: Screen) {
  const { companyId, companyName, base } = screen;
  const db = getDb();
  const [periodRows, years, [settings], equity] = await Promise.all([
    db.select().from(periods).where(eq(periods.companyId, companyId)).orderBy(periods.startsOn),
    db.select().from(financialYears).where(eq(financialYears.companyId, companyId)).orderBy(financialYears.startsOn),
    db.select().from(companySettings).where(eq(companySettings.companyId, companyId)),
    db.select().from(accounts).where(and(eq(accounts.companyId, companyId), eq(accounts.active, true), eq(accounts.type, "equity"))).orderBy(accounts.code),
  ]);
  const manage = has(screen, "manage_company");
  const close = has(screen, "close_period");
  return <>
    <PageHeading title="Accounting settings" company={companyName} />
    {manage && <section className="panel"><h2>Posting policy</h2>
      <FinanceForm action={configureAccountingAction} companyId={companyId} submit={[{ label: "Save posting policy" }]}>
        <div className="form-grid mt-4">
          <label className="field">Manual voucher approval<select name="approval" defaultValue={String(settings.voucherApproval)}>
            <option value="false">Post directly with permission</option><option value="true">Require a different approver for new vouchers</option>
          </select></label>
          <label className="field">Opening balance offset<select name="offsetId" defaultValue={settings.openingOffsetId ?? ""}>
            <option value="">Opening Balance Equity (system)</option>{equity.map((row) => <option key={row.id} value={row.id}>{row.code} · {row.name}</option>)}
          </select></label>
        </div>
      </FinanceForm>
    </section>}
    <PanelTable title="Accounting periods" headers={["Financial year","From","To","Status","Action"]} empty={!periodRows.length ? "No accounting periods configured" : undefined}>
      {periodRows.map((period) => <tr key={period.id}><td>{years.find((year) => year.id === period.yearId)?.name}</td>
        <td>{displayDate(period.startsOn)}</td><td>{displayDate(period.endsOn)}</td><td>{period.closed ? "Closed" : "Open"}</td>
        <td>{close ? <details><summary>{period.closed ? "Reopen period" : "Close period"}</summary>
          <FinanceForm action={periodAction} companyId={companyId} id={period.id} version={period.version}
            submit={[{ label: period.closed ? "Confirm reopening" : "Confirm closure", variant: "outline" }]}>
            <input type="hidden" name="operation" value={period.closed ? "reopen" : "close"} />
            <label className="field">Reason<input name="reason" required minLength={3} maxLength={500} /></label>
          </FinanceForm>
        </details> : "—"}</td></tr>)}
    </PanelTable>
    {close && <section className="panel"><h2>Add accounting period</h2>{years.some((row) => !row.closed) ? <FinanceForm action={periodAction} companyId={companyId}
      submit={[{ label: "Add period" }]}>
      <input type="hidden" name="operation" value="create" />
      <div className="form-grid mt-4">
        <label className="field">Financial year<select name="yearId" required><option value="">Choose a year</option>
          {years.filter((year) => !year.closed).map((year) => <option value={year.id} key={year.id}>{year.name}</option>)}
        </select></label>
        <label className="field">Period starts<input type="date" name="from" required /></label>
        <label className="field">Period ends<input type="date" name="to" required /></label>
      </div>
    </FinanceForm> : <p className="mt-3"><Link className="text-link" href={`${base.replace(/\/accounting$/, "")}/settings#financial-years`}>Configure an open financial year first</Link></p>}</section>}
  </>;
}
