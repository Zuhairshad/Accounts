import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import {
  AlertTriangle, ArrowDownRight, ArrowRight, ArrowUpRight, CalendarCheck, CalendarClock, ChartNoAxesCombined, ChevronDown, ChevronRight, CircleCheck,
  EllipsisVertical, FilePenLine, FilePlus2, HandCoins, Link2Off, ReceiptText, ShoppingCart, TrendingUp, Truck,
} from "lucide-react";
import { OverviewChart } from "@/components/dashboard/overview-chart";
import { AgingDonut, MonthCalendar } from "@/components/dashboard/widgets";
import { RangeForm } from "@/components/range-form";
import { AccessError, getActor } from "@/lib/auth";
import { companyDetails, requireCompany } from "@/lib/companies";
import { loadOverview } from "@/lib/dashboard";
import { formatMoney } from "@/lib/display";
import { first, resolveRange, type Query } from "@/lib/range";
import { displayDate, karachiToday } from "@/lib/validation";

export const metadata = { title: "Dashboard" };

const voucherTypes: Record<string, string> = {
  JV: "Journal voucher", VR: "Voucher", CPV: "Cash payment", CRV: "Cash receipt", BPV: "Bank payment", BRV: "Bank receipt",
  sale: "Sales invoice", purchase: "Purchase invoice", sale_return: "Sales return", purchase_return: "Purchase return",
  opening: "Opening balance", adjustment: "Stock adjustment", reversal: "Reversal",
};
// Avatar tints cycle by name so the same party always gets the same colour.
const tints = ["green", "violet", "amber", "blue", "pink"];
const tint = (name: string) => tints[[...name].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % tints.length];
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]).join("").toUpperCase();

function Pkr({ value }: { value: string }) {
  const negative = value.startsWith("-");
  const [whole, fraction] = formatMoney(negative ? value.slice(1) : value).split(".");
  return <span className="figure">{negative && <span aria-label="minus">−</span>}<small>PKR </small>{whole}<span className="figure-fraction">.{fraction}</span></span>;
}

function Change({ value, inverse = false, label }: { value: number | null; inverse?: boolean; label: string }) {
  if (value === null) return null;
  const up = value >= 0;
  const good = inverse ? !up : up;
  return <span className={`pill ${value === 0 ? "" : good ? "pill-good" : "pill-bad"}`} title={label}>
    {up ? <ArrowUpRight size={13} aria-hidden /> : <ArrowDownRight size={13} aria-hidden />}{Math.abs(value)}%<span className="sr-only"> {label}</span>
  </span>;
}

function CardMenu({ links }: { links: { label: string; href: string }[] }) {
  return <details className="card-menu">
    <summary aria-label="More options"><EllipsisVertical size={17} /></summary>
    <div className="card-menu-panel">{links.map((link) => <Link key={link.href} href={link.href}>{link.label}</Link>)}</div>
  </details>;
}

export default async function Dashboard({ params, searchParams }: { params: Promise<{ companyId: string }>; searchParams: Promise<Query> }) {
  const { companyId } = await params;
  const actor = await getActor();
  if (!actor) redirect("/workspace");
  if (!z.uuid().safeParse(companyId).success) notFound();
  const company = await requireCompany(actor, companyId, "view").catch((error: unknown) => {
    if (error instanceof AccessError) notFound();
    throw error;
  });
  const [{ years }, query] = await Promise.all([companyDetails(companyId), searchParams]);
  const today = karachiToday();
  const selected = years.find((year) => year.id === first(query.year)) ?? (first(query.from) ? undefined : years.find((y) => y.startsOn <= today && y.endsOn >= today));
  const resolved = resolveRange(query, selected);
  // Without an explicit end date, the period stops at today: a dashboard never reports on future days.
  const range = { ...resolved, to: !first(query.to) && resolved.to > today && resolved.from <= today ? today : resolved.to };
  const months = first(query.months) === "6" ? 6 : 12;
  const calendar = /^\d{4}-\d{2}$/.test(first(query.cal) ?? "") ? `${first(query.cal)}-01` : undefined;
  const recentCount = Math.min(50, Math.max(5, Number(first(query.recent)) || 5));
  const todayOnly = first(query.today) === "1";
  const data = await loadOverview(companyId, range, months, { today, calendar, recent: recentCount, todayOnly });
  const base = `/workspace/${companyId}`;
  const can = (permission: string) => company.permissions.includes(permission as never);
  const vs = `vs ${displayDate(data.previous.from)} – ${displayDate(data.previous.to)}`;
  const href = (changes: Record<string, string | undefined>) => {
    const current: Record<string, string | undefined> = { from: first(query.from), to: first(query.to), year: first(query.year), months: first(query.months),
      cal: first(query.cal), recent: first(query.recent), today: first(query.today), ...changes };
    const q = new URLSearchParams(Object.entries(current).filter((entry): entry is [string, string] => !!entry[1]));
    return q.size ? `${base}?${q}` : base;
  };

  const attention = [
    !data.attention.year && { icon: CalendarClock, tone: "bad", text: "No financial year is set up", detail: "Postings need a financial year and an open period.", href: `${base}/settings#financial-years` },
    data.attention.year && !data.attention.openPeriod && { icon: CalendarClock, tone: "bad", text: "No open accounting period for today", detail: "Open a period before posting today's entries.", href: `${base}/accounting/settings` },
    data.overdue.count > 0 && { icon: AlertTriangle, tone: "bad", text: `${data.overdue.count} overdue customer invoice${data.overdue.count === 1 ? "" : "s"}`, detail: `PKR ${formatMoney(data.overdue.amount)} past due`, href: `${base}/reports/aging?to=${range.to}&classification=customer` },
    data.attention.submitted > 0 && { icon: FilePenLine, tone: "warn", text: `${data.attention.submitted} voucher${data.attention.submitted === 1 ? "" : "s"} awaiting approval`, detail: "Submitted drafts need an approver to post them.", href: `${base}/accounting/vouchers?status=draft` },
    data.attention.drafts > 0 && { icon: FilePenLine, tone: "warn", text: `${data.attention.drafts} draft voucher${data.attention.drafts === 1 ? "" : "s"}`, detail: "Drafts have no accounting effect until posted.", href: `${base}/accounting/vouchers?status=draft` },
    data.attention.draftInvoices > 0 && { icon: ReceiptText, tone: "warn", text: `${data.attention.draftInvoices} draft invoice${data.attention.draftInvoices === 1 ? "" : "s"}`, detail: "Not yet posted to the ledger or stock.", href: `${base}/trade/invoices?status=draft` },
    data.attention.unlinked > 0 && { icon: Link2Off, tone: "warn", text: `${data.attention.unlinked} control line${data.attention.unlinked === 1 ? "" : "s"} without a party`, detail: "Link them so party balances match the ledger.", href: `${base}/accounting/repair?from=1900-01-01&to=${range.to}` },
  ].filter((item): item is Exclude<typeof item, false> => !!item);

  const now = new Date();
  const hour = Number(now.toLocaleString("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: "Asia/Karachi" }));
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const clock = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Karachi" });
  const todayDate = new Date(`${today}T00:00:00Z`);
  const weekday = todayDate.toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
  const monthYear = todayDate.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  const pending = data.attention.submitted + data.attention.drafts + data.attention.draftInvoices;
  const agenda = pending || data.overdue.count
    ? `You have ${pending} draft${pending === 1 ? "" : "s"} awaiting posting and ${data.overdue.count} overdue invoice${data.overdue.count === 1 ? "" : "s"} to follow up.`
    : "No drafts awaiting posting and no overdue invoices. You're all caught up.";
  const receivableDiff = Number(data.receivable.value) - Number(data.receivable.previous);
  const overdueShare = Number(data.receivable.value) > 0 ? (Number(data.overdue.amount) / Number(data.receivable.value)) * 100 : 0;
  const quick = [
    can("create") && { label: "Sales invoice", href: `${base}/trade/invoices/new?type=sale`, icon: FilePlus2 },
    can("create") && { label: "Purchase invoice", href: `${base}/trade/invoices/new?type=purchase`, icon: Truck },
    can("create") && { label: "New voucher", href: `${base}/accounting/vouchers/new`, icon: ReceiptText },
    { label: "Reports", href: `${base}/reports`, icon: ChartNoAxesCombined },
  ].filter((item): item is Exclude<typeof item, false> => !!item);

  return <div className="dash">
    <section className="dash-hero" aria-label="Today">
      <div className="dark-card welcome">
        <p className="welcome-hello">{greeting}, {actor.displayName.split(" ")[0]} 👋</p>
        <h1>Dashboard</h1>
        <p className="welcome-company">{company.name}</p>
        <div className="welcome-body">
          <div className="welcome-date"><span>{weekday}</span><b>{todayDate.getUTCDate()}</b><span>{monthYear}</span></div>
          <div className="welcome-agenda">
            <span className="agenda-icon"><CalendarCheck size={17} aria-hidden /></span>
            <p>{agenda}</p>
            <Link href={`${base}/reports/voucher-register?from=${today}&to=${today}`}>View today&apos;s entries <ArrowRight size={13} aria-hidden /></Link>
          </div>
        </div>
      </div>

      <div className="dark-card collections">
        <div className="dark-card-head"><span className="dark-icon"><HandCoins size={17} aria-hidden /></span>
          <div><h2>Today&apos;s Collections</h2><small>As of {clock}</small></div></div>
        <p className="collections-amount"><Pkr value={data.collections.today} /></p>
        <p className="dark-muted">Collected from {data.collections.clients} customer{data.collections.clients === 1 ? "" : "s"}</p>
        {data.collections.rate === null ? <p className="dark-muted collections-foot">No receivables were open on 1 {monthYear}.</p> : <>
          <div className="progress" role="progressbar" aria-label="Month collection rate" aria-valuenow={data.collections.rate} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: `${data.collections.rate}%` }} /></div>
          <p className="dark-muted collections-foot"><span>Collected this month: PKR {formatMoney(data.collections.month)} of {formatMoney(data.collections.owedAtMonthStart)}</span>
            <b>{data.collections.rate}%</b></p>
        </>}
      </div>

      <nav className="dark-card quick" aria-label="Quick access">
        <h2>Quick Access</h2>
        <ul>{quick.map(({ label, href: target, icon: Icon }) => <li key={label}><Link href={target}>
          <Icon size={16} aria-hidden /><span>{label}</span><ChevronRight size={15} aria-hidden /></Link></li>)}</ul>
      </nav>

      <div className="dark-card">
        <MonthCalendar month={data.calendar.month} days={data.calendar.days} today={today} base={base}
          previous={href({ cal: shiftMonth(data.calendar.month, -1) })} next={href({ cal: shiftMonth(data.calendar.month, 1) })} />
      </div>
    </section>

    <div className="dash-period-row">
      <details className="dash-period" open={!!range.error}>
        <summary><CalendarClock size={15} aria-hidden /> {displayDate(range.from)} – {displayDate(range.to)}{selected ? ` · ${selected.name}` : ""}
          <span className="dash-period-action">Change period</span><ChevronDown size={14} aria-hidden /></summary>
        <div className="dash-period-panel"><RangeForm key={`${selected?.id}:${range.from}:${range.to}`} years={years} current={selected?.id} range={range} /></div>
      </details>
      <span className="dash-period-note">Changes compared with the previous {Math.round((Date.parse(range.to) - Date.parse(range.from)) / 86_400_000) + 1} days</span>
    </div>
    {range.error && <p role="alert" className="form-error">{range.error}</p>}

    <section className="stat-row" aria-label="Key figures">
      <article className="stat-card">
        <header><span className="stat-icon tone-green"><ShoppingCart size={20} aria-hidden /></span>
          <div><h2>Net Sales</h2><p>Sales less returns</p></div>
          <CardMenu links={[{ label: "Profit & Loss", href: `${base}/reports/profit-loss?from=${range.from}&to=${range.to}` }]} /></header>
        <div className="stat-body"><p className="stat-value"><Pkr value={data.sales.value} /></p>
          <div className="stat-change"><Change value={data.sales.change} label={vs} /><span>vs previous period</span></div></div>
        <p className={`stat-note ${Number(data.grossProfit) < 0 ? "bad" : "good"}`}>Gross profit PKR {formatMoney(data.grossProfit)}
          {data.margin !== null && ` (${data.margin}% margin)`}</p>
      </article>
      <article className="stat-card">
        <header><span className="stat-icon tone-blue"><TrendingUp size={20} aria-hidden /></span>
          <div><h2>Receivables</h2><p>Outstanding customer balance</p></div>
          <CardMenu links={[{ label: "Debtors report", href: `${base}/reports/debtors?from=${range.from}&to=${range.to}` }, { label: "Aging report", href: `${base}/reports/aging?to=${range.to}` }]} /></header>
        <div className="stat-body"><p className="stat-value"><Pkr value={data.receivable.value} /></p>
          <div className="stat-change"><Change value={data.receivable.change} inverse label={vs} /><span>vs previous period</span></div></div>
        <p className="stat-note">{receivableDiff === 0 ? `${data.receivable.customers} customer${data.receivable.customers === 1 ? "" : "s"} owe you`
          : <span className={receivableDiff > 0 ? "bad" : "good"}>{receivableDiff > 0 ? "+" : "−"} PKR {formatMoney(Math.abs(receivableDiff).toFixed(2))} vs previous period</span>}</p>
      </article>
      <article className="stat-card">
        <header><span className="stat-icon tone-red"><AlertTriangle size={20} aria-hidden /></span>
          <div><h2>Overdue Receivables</h2><p>Invoices past their due date</p></div>
          <CardMenu links={[{ label: "Aging report", href: `${base}/reports/aging?to=${range.to}&classification=customer` }]} /></header>
        <div className="stat-body"><p className="stat-value"><Pkr value={data.overdue.amount} /></p>
          <div className="stat-change"><span className={`pill ${data.overdue.count ? "pill-bad" : "pill-good"}`}>{data.overdue.count} invoice{data.overdue.count === 1 ? "" : "s"}</span><span>past due</span></div></div>
        <p className={`stat-note ${data.overdue.count ? "bad" : "good"}`}>{overdueShare.toFixed(2)}% of receivables</p>
      </article>
    </section>

    <section className="panel table-card" aria-labelledby="recent-title">
      <div className="table-card-head">
        <h2 id="recent-title">Recent Activity</h2>
        <div className="table-card-actions">
          <Link className="switch" role="switch" aria-checked={todayOnly} href={href({ today: todayOnly ? undefined : "1", recent: undefined })}>
            <span>Show only today</span><i aria-hidden /></Link>
          <Link className="button button-outline button-small" href={`${base}/accounting/vouchers`}>View all <ArrowRight size={14} aria-hidden /></Link>
        </div>
      </div>
      {data.recent.length ? <div className="table-scroll"><table className="activity-table">
        <thead><tr><th scope="col">Party</th><th scope="col">Voucher Type</th><th scope="col">Amount</th><th scope="col">Posted On</th><th scope="col">Narration / Reference</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{data.recent.map((entry) => {
          const name = entry.party ?? voucherTypes[entry.type] ?? entry.type;
          return <tr key={entry.id}>
            <td><div className="who"><span className={`avatar avatar-${tint(name)}`} aria-hidden>{initials(name)}</span>
              <div><strong>{name}</strong><small>Voucher: {entry.number}</small></div></div></td>
            <td><strong>{voucherTypes[entry.type] ?? entry.type}</strong><small>{entry.type}</small></td>
            <td className="activity-amount">PKR {formatMoney(entry.amount)}</td>
            <td><span>{displayDate(entry.day)}</span><small>{entry.created}</small></td>
            <td className="activity-narration"><span>{entry.narration || "—"}</span>{entry.reference && <small>Ref: {entry.reference}</small>}</td>
            <td><span className="status status-posted">Posted</span></td>
            <td><CardMenu links={[{ label: "Open voucher", href: `${base}/accounting/vouchers/${entry.id}` },
              { label: "Day's register", href: `${base}/reports/voucher-register?from=${entry.day}&to=${entry.day}` }]} /></td>
          </tr>;
        })}</tbody>
      </table></div> : <p className="table-empty">{todayOnly ? "No vouchers posted today." : "No posted vouchers yet."}</p>}
      {data.moreRecent && <Link className="load-more" href={href({ recent: String(recentCount + 5) })} scroll={false}>Load 5 more <ChevronDown size={14} aria-hidden /></Link>}
    </section>

    <div className="dash-row">
      <section className="panel dash-panel overview" aria-labelledby="overview-title">
        <div className="dash-panel-head">
          <div><h2 id="overview-title">Sales, purchases and profit</h2><p className="muted">Monthly, last {months} months to {displayDate(range.to)}</p></div>
          <nav className="tabs" aria-label="Chart range">
            <Link href={href({ months: "6" })} aria-current={months === 6 ? "page" : undefined}>6 months</Link>
            <Link href={href({ months: "12" })} aria-current={months === 12 ? "page" : undefined}>12 months</Link>
          </nav>
        </div>
        <OverviewChart data={data.monthly} />
        <dl className="overview-stats">
          <div><dt>Cash &amp; bank</dt><dd><Link href={`${base}/reports/cash-bank?from=${range.from}&to=${range.to}`}>{formatMoney(data.cash.value)}</Link></dd></div>
          <div><dt>Payables</dt><dd><Link href={`${base}/reports/creditors?from=${range.from}&to=${range.to}`}>{formatMoney(data.payable.value)}</Link></dd></div>
          <div><dt>Stock value</dt><dd><Link href={`${base}/reports/inventory-valuation?to=${range.to}`}>{formatMoney(data.stock.value)}</Link></dd></div>
          <div><dt>Net profit</dt><dd>{formatMoney(data.netProfit)}</dd></div>
        </dl>
      </section>

      <div className="dash-stack">
        <section className="panel dash-panel attention" aria-labelledby="attention-title">
          <div className="dash-panel-head"><h2 id="attention-title">Needs attention</h2>
            {can("export") && <Link className="text-link" href={`${base}/reconciliation?from=${range.from}&to=${range.to}`}>Reconciliation</Link>}</div>
          {attention.length ? <ul className="attention-list">{attention.map((item) => <li key={item.text}>
            <Link href={item.href}><span className={`attention-icon ${item.tone}`}><item.icon size={17} aria-hidden /></span>
              <span><strong>{item.text}</strong><small>{item.detail}</small></span></Link>
          </li>)}</ul> : <div className="attention-clear"><CircleCheck size={28} aria-hidden /><strong>All clear</strong>
            <p className="muted">No drafts, overdue invoices or unlinked party lines.</p></div>}
        </section>
        <section className="panel dash-panel" aria-labelledby="aging-title">
          <div className="dash-panel-head"><h2 id="aging-title">Receivables by age</h2>
            <Link className="text-link" href={`${base}/reports/aging?to=${range.to}`}>Aging report</Link></div>
          <AgingDonut bands={data.aging} />
        </section>
      </div>
    </div>
  </div>;
}

function shiftMonth(month: string, by: number) {
  const [y, m] = month.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}
