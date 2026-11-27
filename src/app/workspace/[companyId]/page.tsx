import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import {
  AlertTriangle, ArrowDownRight, ArrowUpRight, Banknote, Boxes, CalendarClock, CircleCheck, FilePenLine, FilePlus2, HandCoins,
  Link2Off, Plus, ReceiptText, ShoppingCart, Wallet,
} from "lucide-react";
import { OverviewChart } from "@/components/dashboard/overview-chart";
import { AgingDonut, MiniBars, PostingCalendar, Ring } from "@/components/dashboard/widgets";
import { RangeForm } from "@/components/range-form";
import { AccessError, getActor } from "@/lib/auth";
import { companyDetails, requireCompany } from "@/lib/companies";
import { loadOverview } from "@/lib/dashboard";
import { formatMoney } from "@/lib/display";
import { first, resolveRange, type Query } from "@/lib/range";
import { displayDate, karachiToday } from "@/lib/validation";

export const metadata = { title: "Dashboard" };

function Amount({ value }: { value: string }) {
  const negative = value.startsWith("-");
  const [whole, fraction] = formatMoney(negative ? value.slice(1) : value).split(".");
  return <span className="amount">{negative && <span className="sign" aria-label="minus">−</span>}<small className="currency">PKR</small>{whole}<small>.{fraction}</small></span>;
}

function Change({ value, inverse = false, label }: { value: number | null; inverse?: boolean; label: string }) {
  if (value === null) return <span className="change">No comparison</span>;
  const up = value >= 0;
  const good = inverse ? !up : up;
  return <span className={`change ${value === 0 ? "" : good ? "good" : "bad"}`} title={label}>
    {up ? <ArrowUpRight size={14} aria-hidden /> : <ArrowDownRight size={14} aria-hidden />}
    {up ? "+" : ""}{value}% <span className="sr-only">{label}</span>
  </span>;
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
  const data = await loadOverview(companyId, range, months);
  const base = `/workspace/${companyId}`;
  const can = (permission: string) => company.permissions.includes(permission as never);
  const vs = `vs ${displayDate(data.previous.from)} – ${displayDate(data.previous.to)}`;
  const tab = (value: number) => {
    const q = new URLSearchParams({ from: range.from, to: range.to, months: String(value), ...(selected ? { year: selected.id } : {}) });
    return `${base}?${q}`;
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

  return <div className="dash">
    <header className="dash-head">
      <div>
        <p className="eyebrow">{company.name}</p>
        <h1>Dashboard</h1>
        <p className="muted">{displayDate(range.from)} to {displayDate(range.to)}{selected ? ` · ${selected.name}` : ""} · changes compared with the previous {Math.round((Date.parse(range.to) - Date.parse(range.from)) / 86_400_000) + 1} days</p>
      </div>
      <div className="dash-actions">
        {can("create") && <Link className="button button-primary" href={`${base}/accounting/vouchers/new`}><Plus size={16} /> New voucher</Link>}
        {can("create") && <Link className="button button-outline" href={`${base}/trade/invoices/new?type=sale`}><FilePlus2 size={16} /> Sales invoice</Link>}
      </div>
    </header>

    <details className="dash-period" open={!!range.error}>
      <summary>Change period</summary>
      <RangeForm key={`${selected?.id}:${range.from}:${range.to}`} years={years} current={selected?.id} range={range} />
    </details>
    {range.error && <p role="alert" className="form-error">{range.error}</p>}

    <div className="dash-layout">
      <div className="dash-main">
        <section className="kpi-grid" aria-label="Key figures">
          <Link href={`${base}/reports/cash-bank?from=${range.from}&to=${range.to}`} className="kpi kpi-violet">
            <div className="kpi-top"><span className="kpi-label"><Wallet size={16} aria-hidden /> Cash &amp; bank</span><Change value={data.cash.change} label={vs} /></div>
            <Amount value={data.cash.value} />
            <div className="kpi-foot"><span>Balance on {displayDate(range.to)}</span><MiniBars points={data.cash.trend} /></div>
          </Link>
          <Link href={`${base}/reports/debtors?from=${range.from}&to=${range.to}`} className="kpi kpi-amber">
            <div className="kpi-top"><span className="kpi-label"><HandCoins size={16} aria-hidden /> Receivables</span><Change value={data.receivable.change} inverse label={vs} /></div>
            <Amount value={data.receivable.value} />
            <div className="kpi-foot"><span>{data.receivable.customers} customer{data.receivable.customers === 1 ? "" : "s"} owe you</span>
              <span title="Overdue invoice balances before unallocated receipts are matched to them">{data.overdue.count ? `PKR ${formatMoney(data.overdue.amount)} in overdue invoices` : "No overdue invoices"}</span></div>
          </Link>
          <Link href={`${base}/reports/profit-loss?from=${range.from}&to=${range.to}`} className="kpi kpi-teal kpi-tall">
            <div className="kpi-top"><span className="kpi-label"><ShoppingCart size={16} aria-hidden /> Net sales</span><Change value={data.sales.change} label={vs} /></div>
            <Amount value={data.sales.value} />
            <dl className="kpi-split">
              <div><dt>Gross profit</dt><dd>PKR {formatMoney(data.grossProfit)}</dd></div>
              <div><dt>Net profit</dt><dd>PKR {formatMoney(data.netProfit)}</dd></div>
            </dl>
            <span className="kpi-hint">Sales less returns for the period. Open the Profit &amp; Loss for detail.</span>
          </Link>
          <div className="kpi kpi-white kpi-tall kpi-center">
            <span className="kpi-label">Gross margin</span>
            <Ring value={data.margin} label="Gross margin" />
            <p className="muted">{data.margin === null ? "No sales in this period." : "Gross profit as a share of net sales."}</p>
            <Link className="button button-outline" href={`${base}/reports/profit-loss?from=${range.from}&to=${range.to}`}>Profit &amp; Loss</Link>
          </div>
          <Link href={`${base}/reports/creditors?from=${range.from}&to=${range.to}`} className="kpi kpi-white">
            <div className="kpi-top"><span className="kpi-label"><Banknote size={16} aria-hidden /> Payables</span><Change value={data.payable.change} inverse label={vs} /></div>
            <Amount value={data.payable.value} />
            <div className="kpi-foot"><span>{data.payable.suppliers} supplier{data.payable.suppliers === 1 ? "" : "s"} to pay</span></div>
          </Link>
          <Link href={`${base}/reports/inventory-valuation?to=${range.to}`} className="kpi kpi-white">
            <div className="kpi-top"><span className="kpi-label"><Boxes size={16} aria-hidden /> Stock value</span><Change value={data.stock.change} label={vs} /></div>
            <Amount value={data.stock.value} />
            <div className="kpi-foot"><span>Moving-average value on {displayDate(range.to)}</span></div>
          </Link>
        </section>

        <div className="dash-row">
          <section className="panel dash-panel overview" aria-labelledby="overview-title">
            <div className="dash-panel-head">
              <div><h2 id="overview-title">Sales, purchases and profit</h2><p className="muted">Monthly, last {months} months to {displayDate(range.to)}</p></div>
              <nav className="tabs" aria-label="Chart range">
                <Link href={tab(6)} aria-current={months === 6 ? "page" : undefined}>6 months</Link>
                <Link href={tab(12)} aria-current={months === 12 ? "page" : undefined}>12 months</Link>
              </nav>
            </div>
            <OverviewChart data={data.monthly} />
            <dl className="overview-stats">
              <div><dt>Vouchers posted</dt><dd>{data.counts.vouchers}</dd></div>
              <div><dt>Invoices posted</dt><dd>{data.counts.invoices}</dd></div>
              <div><dt>Gross profit</dt><dd>{formatMoney(data.grossProfit)}</dd></div>
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
      </div>

      <aside className="dash-aside" aria-label="Calendar and activity">
        <div className="aside-dark">
          <PostingCalendar month={data.calendar.month} days={data.calendar.days} today={today} base={base} />
          <h2 className="aside-title">Recent activity</h2>
          {data.recent.length ? <ul className="activity">{data.recent.map((entry) => {
            const date = new Date(`${entry.day}T00:00:00Z`);
            return <li key={entry.id}><Link href={`${base}/accounting/vouchers/${entry.id}`}>
              <span className="activity-date"><b>{date.getUTCDate()}</b>{date.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" })}</span>
              <span className="activity-body"><strong>{entry.number}</strong><small>{entry.narration || entry.type}</small></span>
              <span className="activity-amount">{formatMoney(entry.amount)}</span>
            </Link></li>;
          })}</ul> : <p className="aside-empty">No posted vouchers yet.</p>}
        </div>
      </aside>
    </div>
  </div>;
}
