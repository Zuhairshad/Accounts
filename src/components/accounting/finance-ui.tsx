import Link from "next/link";
import { CalendarDays, Filter } from "lucide-react";
import { Button } from "../ui/button";
import { formatMoney } from "@/lib/display";
import { first, resolveRange, type Query } from "@/lib/range";
import { displayDate } from "@/lib/validation";
import { Exact } from "@/lib/engine/model";
import type { readLedger } from "@/lib/engine/read";

export function PageHeading({ title, company, toolbar }: { title: string; company: string; toolbar?: React.ReactNode }) {
  return <div className="page-heading"><div><p className="eyebrow">{company}</p><h1>{title}</h1></div>
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
  return <>
    <div className="stats-grid">
      <div className="panel stat"><span className="muted">Opening balance (PKR)</span><strong>{sided(result.opening)}</strong></div>
      <div className="panel stat"><span className="muted">Closing balance (PKR)</span><strong>{sided(result.closing)}</strong></div>
      <div className="panel stat"><span className="muted">Reporting period</span><strong className="text-xl">{displayDate(from)} to {displayDate(to)}</strong></div>
    </div>
    <PanelTable title="Posted ledger" headers={["Date","Voucher","Type","Reference","Account","Narration","Debit (PKR)","Credit (PKR)","Running balance"]}
      empty={result.rows.length ? undefined : "No posted entries in this period"}>
      {result.rows.map((row) => <tr key={row.id}>
        <td>{displayDate(row.date!)}</td><td><Link className="text-link" href={`${base}/vouchers/${row.documentId}`}>{row.number}</Link></td>
        <td>{row.type}</td><td>{row.reference || "—"}</td><td>{row.code} · {row.account}</td><td>{row.narration}</td>
        <Money value={row.debit!} /><Money value={row.credit!} /><td className="money-cell">{sided(row.running!)}</td>
      </tr>)}
    </PanelTable>
  </>;
}
