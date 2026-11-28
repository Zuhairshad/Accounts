import Link from "next/link";
import { ArrowDownToLine, ArrowUpFromLine, CalendarDays, Filter, Scale } from "lucide-react";
import { Button } from "../ui/button";
import { formatMoney } from "@/lib/display";
import { first, resolveRange, type Query } from "@/lib/range";
import { displayDate } from "@/lib/validation";
import { Exact } from "@/lib/engine/model";
import type { readLedger } from "@/lib/engine/read";
import { AccTable, SidedFigure, StatCard, voucherTypes } from "./acc-ui";

export function PageHeading({ title, company, toolbar, subtitle }: { title: string; company: string; toolbar?: React.ReactNode; subtitle?: React.ReactNode }) {
  return <div className="page-heading"><div><p className="eyebrow">{company}</p><h1>{title}</h1>{subtitle && <p className="acc-subtitle">{subtitle}</p>}</div>
    {toolbar && <div className="finance-toolbar print-hide">{toolbar}</div>}
  </div>;
}

export function PanelTable({ title, headers, children, empty }: {
  title: string; headers: string[]; children?: React.ReactNode; empty?: string;
}) {
  return <section className="panel data-panel">
    <div className="panel-heading"><h2>{title}</h2></div>
    <div className="table-scroll"><table><thead><tr>{headers.map((header) => <th key={header} scope="col">{header}</th>)}</tr></thead>
      <tbody>{children}</tbody></table></div>
    {empty && <div className="empty"><strong>{empty}</strong></div>}
  </section>;
}

export function DateFilters({ query, asOf, children, withSearch, dateLabel = "Reporting period" }: {
  query: Query; asOf?: string; children?: React.ReactNode; withSearch?: boolean; dateLabel?: string;
}) {
  const range = resolveRange(query);
  return <form className="range-form panel print-hide" method="get">
    <div className="range-title"><CalendarDays size={20} /><strong>{dateLabel}</strong></div>
    {asOf ? <label className="field">As of<input type="date" name="asOf" defaultValue={asOf} required /></label> : <>
      <label className="field">From<input type="date" name="from" defaultValue={range.from} required /></label>
      <label className="field">To<input type="date" name="to" defaultValue={range.to} required /></label>
    </>}
    {withSearch && <label className="field">Search<input name="q" defaultValue={first(query.q) ?? ""} maxLength={100} /></label>}
    {children}
    <Button variant="outline" type="submit"><Filter size={16} /> Apply filters</Button>
    {!asOf && range.error && <p className="form-error" role="alert">{range.error}</p>}
  </form>;
}

export function sided(value: string) {
  const decimal = new Exact(value);
  return `${formatMoney(decimal.abs().toFixed(2))}${decimal.isZero() ? "" : decimal.gt(0) ? " Dr" : " Cr"}`;
}

export function Money({ value }: { value: string }) {
  return <td className="money-cell">{formatMoney(value)}</td>;
}

export function Ledger({ result, base, from, to }: { result: Awaited<ReturnType<typeof readLedger>>; base: string; from: string; to: string }) {
  const sum = (side: "debit" | "credit") => result.rows.reduce((total, row) => total.plus(row[side] ?? "0"), new Exact(0)).toFixed(2);
  const zero = (value: string) => new Exact(value).isZero();
  return <>
    <section className="stat-row acc-stat-row" aria-label="Ledger balances">
      <StatCard icon={<ArrowDownToLine size={20} />} tone="slate" title="Opening balance (PKR)" subtitle={`Brought forward to ${displayDate(from)}`}
        value={<SidedFigure value={sided(result.opening)} />} />
      <StatCard icon={<Scale size={20} />} tone="blue" title="Reporting period" subtitle={`${displayDate(from)} to ${displayDate(to)}`}
        value={<>{result.rows.length}<small className="acc-unit"> {result.rows.length === 1 ? "entry" : "entries"}</small></>}
        note={<>Debits PKR {formatMoney(sum("debit"))} · Credits PKR {formatMoney(sum("credit"))}</>} />
      <StatCard icon={<ArrowUpFromLine size={20} />} tone="green" title="Closing balance (PKR)" subtitle={`Carried forward at ${displayDate(to)}`}
        value={<SidedFigure value={sided(result.closing)} />} />
    </section>
    <AccTable title="Posted ledger" subtitle="Running balance in PKR, oldest entry first"
      headers={["Date","Voucher","Account","Narration / Reference",{ label: "Debit (PKR)", num: true },{ label: "Credit (PKR)", num: true },{ label: "Running balance", num: true }]}
      empty={result.rows.length ? undefined : "No posted entries in this period"}>
      {result.rows.map((row) => <tr key={row.id}>
        <td className="acc-nowrap">{displayDate(row.date!)}</td>
        <td><Link className="acc-strong-link" href={`${base}/vouchers/${row.documentId}`}>{row.number}</Link><small>{voucherTypes[row.type!] ?? row.type}</small></td>
        <td><span className="acc-code">{row.code}</span> {row.account}</td>
        <td className="acc-narration"><span>{row.narration || "—"}</span>{row.reference && <small>Ref: {row.reference}</small>}</td>
        <td className={`acc-num${zero(row.debit!) ? " acc-zero" : ""}`}>{formatMoney(row.debit!)}</td>
        <td className={`acc-num${zero(row.credit!) ? " acc-zero" : ""}`}>{formatMoney(row.credit!)}</td>
        <td className="acc-num acc-running">{sided(row.running!)}</td>
      </tr>)}
    </AccTable>
  </>;
}
