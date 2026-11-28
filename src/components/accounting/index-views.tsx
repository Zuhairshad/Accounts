import Link from "next/link";
import { CalendarPlus, Filter, Inbox, Plus, RotateCcw, Scale, ShieldCheck, Trash2, TrendingDown, TrendingUp, Truck, Users, Wallet } from "lucide-react";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { accounts, companySettings, financialYears, parties, periods } from "@/db/schema";
import { Button } from "../ui/button";
import { PageHeading, sided } from "./finance-ui";
import { AccCard, AccFilters, AccTable, CardMenu, Num, SidedFigure, StatCard, StatusPill, voucherTypes, Who } from "./acc-ui";
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

// Short codes and tints for the voucher type chip in registers; purely visual.
const typeChip: Record<string, [string, string]> = {
  CRV: ["CRV", "green"], BRV: ["BRV", "green"], CPV: ["CPV", "pink"], BPV: ["BPV", "pink"], JV: ["JV", "blue"], VR: ["VR", "blue"],
  sale: ["SI", "green"], purchase: ["PI", "pink"], sale_return: ["SR", "violet"], purchase_return: ["PR", "violet"],
  opening: ["OB", "amber"], adjustment: ["ADJ", "amber"], reversal: ["REV", "violet"],
};

export function VoucherDoc({ type, number, href }: { type: string; number: string; href: string }) {
  const [code, tone] = typeChip[type] ?? [type.slice(0, 3).toUpperCase(), "blue"];
  return <div className="who"><span className={`avatar avatar-${tone} acc-type-chip`} aria-hidden>{code}</span>
    <div className="acc-who-text"><Link className="acc-strong-link" href={href}>{number}</Link><small>{voucherTypes[type] ?? type.replaceAll("_", " ")}</small></div></div>;
}

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
  const pdf = `/api/accounting/${companyId}/vouchers`;
  return <>
    <PageHeading title="Voucher register" company={companyName} subtitle="Journal, cash and bank vouchers with their drafts" toolbar={<>
      <Button asChild variant="outline"><Link href={`${base}/recycle`}><Trash2 size={16} /> Recycle bin</Link></Button>
      {has(screen, "create") && <Button asChild><a href={`${base}/vouchers/new`}><Plus size={16} /> New voucher</a></Button>}
    </>} />
    <AccFilters query={query} withSearch>
      <label className="field">Voucher type<select name="type" defaultValue={type}>
        <option value="">All types</option>{[...manualTypes,"opening","sale","purchase","sale_return","purchase_return","adjustment","reversal"].map((value) => <option key={value}>{value}</option>)}
      </select></label>
      <label className="field">Status<select name="status" defaultValue={status}><option value="">Draft and posted</option><option value="draft">Draft</option><option value="posted">Posted</option></select></label>
    </AccFilters>
    <AccTable title="Vouchers" subtitle={`${total} ${total === 1 ? "voucher" : "vouchers"} · ${displayDate(parsed.from)} to ${displayDate(parsed.to)}`}
      headers={["Voucher","Date","Narration / Reference","Status",{ label: "Posted amount (PKR)", num: true },{ label: "Actions", hidden: true }]}
      empty={!rows.length ? "No vouchers match your filters" : undefined}>
      {rows.map((row) => <tr key={row.id}>
        <td><VoucherDoc type={row.type} number={row.number || "Open draft"} href={`${base}/vouchers/${row.id}`} /></td>
        <td className="acc-nowrap">{displayDate(row.date)}</td>
        <td className="acc-narration"><span>{row.narration || "—"}</span>{row.reference && <small>Ref: {row.reference}</small>}</td>
        <td><StatusPill status={row.status}>{row.status[0].toUpperCase() + row.status.slice(1)}</StatusPill></td>
        {row.status === "posted" ? <Num value={row.total} strong /> : <td className="acc-num acc-zero">—</td>}
        <td className="acc-menu-cell"><CardMenu label={`More options for ${row.number || "draft"}`} links={[{ label: "Open voucher", href: `${base}/vouchers/${row.id}` },
          ...(has(screen, "print") ? [{ label: "Print voucher", href: `${pdf}/${row.id}?inline=1`, external: true }] : [])]} /></td>
      </tr>)}
    </AccTable>
    {(page > 1 || total > page * 50) && <nav className="acc-pager print-hide" aria-label="Pages">{page > 1 && <Link className="button button-outline button-small" href={link(page - 1)}>Previous page</Link>}
      <span>Page {page} of {Math.max(1, Math.ceil(total / 50))}</span>{total > page * 50 && <Link className="button button-outline button-small" href={link(page + 1)}>Next page</Link>}</nav>}
  </>;
}

const classes = ["asset","liability","equity","income","expense"] as const;

export async function ChartIndex(screen: Screen) {
  const { companyId, companyName, base, query } = screen;
  const rows = await getDb().select().from(accounts).where(eq(accounts.companyId, companyId)).orderBy(accounts.code);
  const q = (first(query.q) ?? "").trim().toLowerCase().slice(0, 100);
  const type = first(query.type);
  const filtered = rows.filter((row) => (!q || `${row.code} ${row.name}`.toLowerCase().includes(q)) && (!type || row.type === type));
  const tab = (value?: string) => `${base}/chart?${new URLSearchParams({ q, type: value ?? "" })}`;
  return <>
    <PageHeading title="Chart of accounts" company={companyName} subtitle="Account heads by classification, with their ledgers" toolbar={<>
      <Button asChild variant="outline"><Link href={`${base}/opening`}>Opening balances</Link></Button>
      {has(screen, "create") && <Button asChild><a href={`${base}/chart/new`}><Plus size={16} /> Add account</a></Button>}
    </>} />
    <form className="panel acc-filters" method="get">
      <div className="acc-filters-row">
        <label className="field acc-field-grow">Search accounts<input name="q" defaultValue={q} maxLength={100} placeholder="Code or name" /></label>
        <label className="field">Classification<select name="type" defaultValue={type ?? ""}><option value="">All</option>
          {classes.map((value) => <option key={value}>{value}</option>)}</select></label>
        <Button type="submit" variant="outline" className="acc-filter-submit"><Filter size={15} /> Apply filters</Button>
      </div>
    </form>
    <AccTable title="Account heads" subtitle={`${filtered.length} of ${rows.length} accounts`}
      actions={<nav className="tabs acc-tabs" aria-label="Classification">
        <Link href={tab()} aria-current={!type ? "page" : undefined}>All <b>{rows.length}</b></Link>
        {classes.map((value) => <Link key={value} href={tab(value)} aria-current={type === value ? "page" : undefined} className="capitalize">
          {value} <b>{rows.filter((row) => row.type === value).length}</b></Link>)}
      </nav>}
      headers={["Code","Account","Classification","Main head","Status",{ label: "Ledger", num: true }]} empty={!filtered.length ? "No accounts match your filters" : undefined}>
      {filtered.map((row) => <tr key={row.id}><td><span className="acc-code">{row.code}</span></td>
        <td><Link href={`${base}/chart/${row.id}`} className="acc-strong-link">{row.name}</Link>
          {(row.control || row.liquidity) && <small>{[row.control && "System", row.liquidity && `${row.liquidity} account`].filter(Boolean).join(" · ")}</small>}</td>
        <td><span className={`acc-class acc-class-${row.type}`}>{row.type}</span></td><td>{rows.find((parent) => parent.id === row.parentId)?.name ?? <span className="muted">—</span>}</td>
        <td><StatusPill status={row.active ? "active" : "inactive"}>{row.active ? "Active" : "Inactive"}</StatusPill></td>
        <td className="acc-num"><Link href={`${base}/ledger/${row.id}`} className="text-link acc-small-link">View ledger</Link></td>
      </tr>)}
    </AccTable>
  </>;
}

export async function PartyIndex(screen: Screen) {
  const { companyId, companyName, base, query } = screen;
  const rows = await partyBalances(getDb(), companyId, karachiToday());
  const q = (first(query.q) ?? "").trim().toLowerCase().slice(0, 100);
  const type = first(query.type);
  const visible = rows.filter((row) => (!q || row.name.toLowerCase().includes(q)) && (!type || row.type === type));
  const customers = rows.filter((row) => row.type === "customer");
  const suppliers = rows.filter((row) => row.type === "supplier");
  const owed = (list: typeof rows, sign: 1 | -1) => list.reduce((total, row) => total.plus(Exact.max(new Exact(row.balance).times(sign), 0)), new Exact(0)).toFixed(2);
  return <>
    <PageHeading title="Customers and suppliers" company={companyName} subtitle="Party master with current ledger balances" toolbar={<>
      <Button asChild variant="outline"><Link href={`${base}/opening`}>Opening balances</Link></Button>
      {has(screen, "create") && <Button asChild><a href={`${base}/parties/new`}><Plus size={16} /> Add party</a></Button>}
    </>} />
    <section className="stat-row acc-stat-row" aria-label="Party summary">
      <StatCard icon={<Users size={20} />} title="Customers" subtitle={`${customers.filter((row) => row.active).length} active`}
        value={customers.length} note={<>Receivable PKR {formatMoney(owed(customers, 1))}</>} noteTone="good" />
      <StatCard icon={<Truck size={20} />} tone="blue" title="Suppliers" subtitle={`${suppliers.filter((row) => row.active).length} active`}
        value={suppliers.length} note={<>Payable PKR {formatMoney(owed(suppliers, -1))}</>} />
      <StatCard icon={<Scale size={20} />} tone="slate" title="Net party position" subtitle="All customer and supplier balances"
        value={<SidedFigure value={sided(rows.reduce((total, row) => total.plus(row.balance), new Exact(0)).toFixed(2))} />} />
    </section>
    <form className="panel acc-filters" method="get">
      <div className="acc-filters-row">
        <label className="field acc-field-grow">Search parties<input name="q" defaultValue={q} maxLength={100} placeholder="Party name" /></label>
        <label className="field">Classification<select name="type" defaultValue={type ?? ""}><option value="">All</option><option value="customer">Customer</option><option value="supplier">Supplier</option></select></label>
        <Button variant="outline" type="submit" className="acc-filter-submit"><Filter size={15} /> Apply filters</Button>
      </div>
    </form>
    <AccTable title="Party master" subtitle={`${visible.length} of ${rows.length} parties`}
      headers={["Party","Classification","Status",{ label: "Current balance (PKR)", num: true },"Ledger",{ label: "Actions", hidden: true }]} empty={!visible.length ? "No parties match your filters" : undefined}>
      {visible.map((row) => <tr key={row.id}>
        <td><Who name={row.name} href={`${base}/parties/${row.id}`} /></td>
        <td><span className={`acc-class acc-class-${row.type}`}>{row.type}</span></td>
        <td><StatusPill status={row.active ? "active" : "inactive"}>{row.active ? "Active" : "Inactive"}</StatusPill></td>
        <td className="acc-num"><SidedFigure value={sided(row.balance)} /></td>
        <td><Link className="text-link acc-small-link" href={`${base}/party-ledger/${row.id}`}>View ledger</Link></td>
        <td className="acc-menu-cell"><CardMenu label={`More options for ${row.name}`} links={[{ label: "Party details", href: `${base}/parties/${row.id}` },
          { label: "Payments and allocations", href: `${base}/allocations/${row.id}` }]} /></td>
      </tr>)}
    </AccTable>
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
    <PageHeading title="Opening balances" company={companyName} subtitle="Bulk opening balances for account heads and parties"
      toolbar={target && <Button asChild variant="outline"><Link href={`${base}/opening`}>All opening balances</Link></Button>} />
    <AccCard title="Accounts and parties" className="acc-grid-card"
      subtitle="Select the rows to save together. Enter receivables and payables against their individual parties.">
      <FinanceForm action={saveOpeningAction} companyId={companyId} className="acc-sheet-form" submit={canPost && rows.length ? [{ label: "Save selected opening balances" }] : []}>
        <div className="table-scroll acc-sheet"><table className="entry-table acc-grid acc-opening-grid"><thead><tr><th>Apply</th><th>Account or party</th><th>Opening date</th><th>Direction</th><th className="acc-num">Amount (PKR)</th></tr></thead>
          <tbody>{rows.map((row) => {
            const saved = byTarget.get(row.id);
            return <tr key={row.id} className={row.active ? undefined : "acc-row-muted"}><td className="acc-grid-check">
              <input type="hidden" name={`kind.${row.id}`} value={row.kind} />
              <input type="hidden" name={`version.${row.id}`} value={saved?.version ?? 0} />
              {canPost && <input aria-label={`Select ${row.name}`} type="checkbox" name="selected" value={row.id} defaultChecked={!!target} disabled={!row.active} />}
            </td><td><span className="acc-grid-name">{row.name}</span><small className="muted block capitalize">{row.kind === "party" ? row.type : `${row.type} account`}{row.active ? "" : " · inactive"}</small></td>
              <td>{canPost ? <input aria-label={`Opening date for ${row.name}`} name={`date.${row.id}`} type="date" defaultValue={saved?.date ?? today} /> : saved ? displayDate(saved.date) : "—"}</td>
              <td>{canPost ? <select aria-label={`Opening direction for ${row.name}`} name={`direction.${row.id}`} defaultValue={saved?.direction ?? (row.type === "supplier" ? "credit" : "debit")}>
                <option value="debit">Debit</option><option value="credit">Credit</option></select> : saved?.direction ?? "—"}</td>
              <td className="acc-num">{canPost ? <input className="acc-amount" aria-label={`Opening amount for ${row.name}`} name={`amount.${row.id}`} inputMode="decimal" maxLength={21} defaultValue={saved?.amount ?? "0"} /> : saved?.amount ?? "0.00"}</td>
            </tr>;
          })}</tbody></table></div>
        {canPost && rows.length > 0 && <label className="field acc-reason">Reason<input name="reason" required minLength={3} maxLength={500} /></label>}
      </FinanceForm>
      {!rows.length && <div className="table-empty acc-empty"><Inbox size={22} aria-hidden /><strong>There are no opening balance targets in this selection.</strong></div>}
    </AccCard>
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
  const customer = role === "customer";
  return <>
    <PageHeading title={customer ? "Debtors report" : "Creditors report"} company={companyName}
      subtitle={customer ? "What customers owe, with open invoices by age" : "What you owe suppliers, with open invoices by age"} />
    <AccFilters query={query} asOf={asOf} />
    <section className="stat-row acc-stat-row" aria-label="Party totals">
      <StatCard icon={customer ? <TrendingUp size={20} /> : <TrendingDown size={20} />} tone={customer ? "green" : "red"}
        title={`${customer ? "Receivables" : "Payables"} (PKR)`} subtitle={`Owed ${customer ? "by customers" : "to suppliers"} at ${displayDate(asOf)}`}
        value={formatMoney(owed.toFixed(2))} aside={<span className="pill">{data.parties.length} {data.parties.length === 1 ? "party" : "parties"}</span>} />
      <StatCard icon={<Wallet size={20} />} tone="blue" title="Advances (PKR)" subtitle={customer ? "Paid in advance by customers" : "Paid in advance to suppliers"}
        value={formatMoney(advances.toFixed(2))} />
      <StatCard icon={<Scale size={20} />} tone="slate" title="Net party balance (PKR)" subtitle="Receivables less advances"
        value={<SidedFigure value={sided(owed.minus(advances).times(sign).toFixed(2))} />}
        aside={<span className={`pill ${data.invoices.length ? "pill-bad" : "pill-good"}`}>{data.invoices.length} open {data.invoices.length === 1 ? "invoice" : "invoices"}</span>} />
    </section>
    {data.unlinked.count !== "0" && <div className="setup-callout acc-callout"><p>
      The control account includes {data.unlinked.count} unlinked journal lines, net {sided(data.unlinked.balance)} PKR.
    </p><Link className="text-link" href={`${base}/repair?from=1900-01-01&to=${asOf}`}>Review legacy party links</Link></div>}
    <AccTable title="Party balances" subtitle={`Nonzero balances as of ${displayDate(asOf)}`} headers={["Party","Status",{ label: "Ledger balance (PKR)", num: true }]}
      empty={!data.parties.length ? "No nonzero party balances as of this date" : undefined}>
      {data.parties.map((row) => <tr key={row.id}><td><Who name={row.name} href={`${base}/party-ledger/${row.id}?from=${asOf.slice(0, 7)}-01&to=${asOf}`} /></td>
        <td><StatusPill status={row.active ? "active" : "inactive"}>{row.active ? "Active" : "Inactive"}</StatusPill></td><td className="acc-num"><SidedFigure value={sided(row.balance)} /></td></tr>)}
    </AccTable>
    <InvoiceAging rows={data.invoices} />
  </>;
}

const band = (days: number) => days === 0 ? "Current" : days <= 30 ? "1–30 days" : days <= 60 ? "31–60 days" : days <= 90 ? "61–90 days" : "Over 90 days";

export function InvoiceAging({ rows }: { rows: Awaited<ReturnType<typeof invoiceOutstanding>> }) {
  return <AccTable title="Invoice aging" subtitle="Posted invoices with an outstanding amount" compact
    headers={["Invoice","Party","Invoice date","Due date",...["Invoice amount","Paid on invoice","Credit notes","Allocated","Outstanding","Days overdue"].map((label) => ({ label, num: true })),"Age band"]}
    empty={!rows.length ? "No outstanding posted invoices for this selection" : undefined}>
    {rows.map((row) => <tr key={row.id}><td><strong>{row.number}</strong></td><td>{row.party}</td><td className="acc-nowrap">{displayDate(row.date)}</td><td className="acc-nowrap">{displayDate(row.dueOn)}</td>
      <Num value={row.invoiceAmount} /><Num value={row.embeddedSettlement} /><Num value={row.creditNotes} /><Num value={row.allocated} /><Num value={row.outstanding} strong />
      <td className="acc-num">{row.overdueDays}</td>
      <td><span className={`status ${row.overdueDays === 0 ? "status-posted" : row.overdueDays <= 30 ? "acc-status-draft" : "acc-status-void"}`}>{band(row.overdueDays)}</span></td></tr>)}
  </AccTable>;
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
    <PageHeading title="Recycle bin" company={companyName} subtitle="Voided transactions you can preview and restore" toolbar={
      <Button asChild variant="outline"><Link href={`${base}/vouchers`}>Voucher register</Link></Button>} />
    <AccFilters query={query} withSearch dateLabel="Deletion date">
      <label className="field">Deleted by<input name="user" defaultValue={user} maxLength={100} /></label>
      <label className="field">Type<select name="type" defaultValue={type}><option value="">All types</option>
        {[...manualTypes, "opening"].map((value) => <option key={value}>{value}</option>)}</select></label>
    </AccFilters>
    <AccTable title="Voided transactions" subtitle={`${result.rows.length} ${result.rows.length === 1 ? "transaction" : "transactions"} · ${displayDate(range.from)} to ${displayDate(range.to)}`}
      headers={["Transaction","Deleted on","Deleted by","Reason",{ label: "Action", num: true }]}
      empty={!result.rows.length ? "No voided transactions match your filters" : undefined}>
      {result.rows.map((row) => <tr key={row.id}>
        <td><VoucherDoc type={row.type} number={row.number || "Preview draft"} href={`${base}/vouchers/${row.id}`} /></td>
        <td className="acc-nowrap">{displayDate(row.date)}</td>
        <td><Who name={row.deletedBy} /></td>
        <td className="acc-narration"><span>{row.reason}</span><small><StatusPill status="void">Voided</StatusPill></small></td>
        <td className="acc-num"><Link className="button button-outline button-small" href={`${base}/vouchers/${row.id}`}>
          {has(screen, "restore") ? <><RotateCcw size={14} aria-hidden />Preview and restore</> : "Preview"}</Link></td></tr>)}
    </AccTable>
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
    <PageHeading title="Accounting settings" company={companyName} subtitle="Posting approvals and accounting period close" />
    {manage && <AccCard title="Posting policy" subtitle="Who may post manual vouchers, and where opening balances are offset" icon={<ShieldCheck size={18} />}>
      <FinanceForm action={configureAccountingAction} companyId={companyId} submit={[{ label: "Save posting policy" }]}>
        <div className="form-grid acc-form-grid">
          <label className="field">Manual voucher approval<select name="approval" defaultValue={String(settings.voucherApproval)}>
            <option value="false">Post directly with permission</option><option value="true">Require a different approver for new vouchers</option>
          </select></label>
          <label className="field">Opening balance offset<select name="offsetId" defaultValue={settings.openingOffsetId ?? ""}>
            <option value="">Opening Balance Equity (system)</option>{equity.map((row) => <option key={row.id} value={row.id}>{row.code} · {row.name}</option>)}
          </select></label>
        </div>
      </FinanceForm>
    </AccCard>}
    <AccTable title="Accounting periods" subtitle={`${periodRows.filter((period) => !period.closed).length} open · ${periodRows.filter((period) => period.closed).length} closed`}
      headers={["Financial year","From","To","Status","Action"]} empty={!periodRows.length ? "No accounting periods configured" : undefined}>
      {periodRows.map((period) => <tr key={period.id}><td><strong>{years.find((year) => year.id === period.yearId)?.name}</strong></td>
        <td className="acc-nowrap">{displayDate(period.startsOn)}</td><td className="acc-nowrap">{displayDate(period.endsOn)}</td>
        <td><StatusPill status={period.closed ? "closed" : "open"}>{period.closed ? "Closed" : "Open"}</StatusPill></td>
        <td>{close ? <details className="acc-inline-action"><summary>{period.closed ? "Reopen period" : "Close period"}</summary>
          <FinanceForm action={periodAction} companyId={companyId} id={period.id} version={period.version}
            submit={[{ label: period.closed ? "Confirm reopening" : "Confirm closure", variant: "outline" }]}>
            <input type="hidden" name="operation" value={period.closed ? "reopen" : "close"} />
            <label className="field">Reason<input name="reason" required minLength={3} maxLength={500} /></label>
          </FinanceForm>
        </details> : "—"}</td></tr>)}
    </AccTable>
    {close && <AccCard title="Add accounting period" subtitle="Periods must fall inside an open financial year" icon={<CalendarPlus size={18} />}>{years.some((row) => !row.closed) ? <FinanceForm action={periodAction} companyId={companyId}
      submit={[{ label: "Add period" }]}>
      <input type="hidden" name="operation" value="create" />
      <div className="form-grid acc-form-grid acc-cols-3">
        <label className="field">Financial year<select name="yearId" required><option value="">Choose a year</option>
          {years.filter((year) => !year.closed).map((year) => <option value={year.id} key={year.id}>{year.name}</option>)}
        </select></label>
        <label className="field">Period starts<input type="date" name="from" required /></label>
        <label className="field">Period ends<input type="date" name="to" required /></label>
      </div>
    </FinanceForm> : <p className="mt-3"><Link className="text-link" href={`${base.replace(/\/accounting$/, "")}/settings#financial-years`}>Configure an open financial year first</Link></p>}</AccCard>}
  </>;
}
