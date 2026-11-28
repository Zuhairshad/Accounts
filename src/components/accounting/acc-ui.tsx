import Link from "next/link";
import { CalendarDays, EllipsisVertical, Filter, Inbox } from "lucide-react";
import { Button } from "../ui/button";
import { formatMoney } from "@/lib/display";
import { first, resolveRange, type Query } from "@/lib/range";

/** Presentation helpers for the accounting pages. They only arrange data the views already read. */
export const voucherTypes: Record<string, string> = {
  JV: "Journal voucher", VR: "Voucher", CPV: "Cash payment", CRV: "Cash receipt", BPV: "Bank payment", BRV: "Bank receipt",
  sale: "Sales invoice", purchase: "Purchase invoice", sale_return: "Sales return", purchase_return: "Purchase return",
  opening: "Opening balance", adjustment: "Stock adjustment", reversal: "Reversal",
};
// Avatar tints cycle by name so the same party always gets the same colour (same rule as the dashboard).
const tints = ["green", "violet", "amber", "blue", "pink"];
export const tint = (name: string) => tints[[...name].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % tints.length];
export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]).join("").toUpperCase();

export function Who({ name, sub, href }: { name: string; sub?: React.ReactNode; href?: string }) {
  return <div className="who"><span className={`avatar avatar-${tint(name)}`} aria-hidden>{initials(name)}</span>
    <div className="acc-who-text">{href ? <Link className="acc-strong-link" href={href}>{name}</Link> : <strong>{name}</strong>}{sub && <small>{sub}</small>}</div></div>;
}

/** Status pill; the visible text stays the raw status so screen readers and tests read the same word. */
export function StatusPill({ status, children, className = "" }: { status: string; children?: React.ReactNode; className?: string }) {
  const tone = ["posted", "active", "open", "paid", "current"].includes(status.toLowerCase()) ? "status-posted"
    : ["draft", "awaiting approval", "partial"].includes(status.toLowerCase()) ? "acc-status-draft"
      : ["void", "voided", "closed", "overdue"].includes(status.toLowerCase()) ? "acc-status-void" : "acc-status-neutral";
  return <span className={`status ${tone} ${className}`}>{children ?? status}</span>;
}

export function CardMenu({ links, label = "More options" }: { links: { label: string; href: string; external?: boolean }[]; label?: string }) {
  return <details className="card-menu acc-menu">
    <summary aria-label={label}><EllipsisVertical size={17} /></summary>
    <div className="card-menu-panel">{links.map((link) => link.external
      ? <a key={link.href} href={link.href} target="_blank" rel="noreferrer">{link.label}</a>
      : <Link key={link.href} href={link.href}>{link.label}</Link>)}</div>
  </details>;
}

export function AccCard({ title, subtitle, actions, children, className = "", icon }: {
  title: string; subtitle?: React.ReactNode; actions?: React.ReactNode; children?: React.ReactNode; className?: string; icon?: React.ReactNode;
}) {
  return <section className={`panel acc-card ${className}`}>
    <div className="acc-card-head">
      {icon && <span className="acc-card-icon" aria-hidden>{icon}</span>}
      <div className="acc-card-title"><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
      {actions && <div className="acc-card-actions">{actions}</div>}
    </div>
    {children}
  </section>;
}

export type Header = string | { label: string; num?: boolean; hidden?: boolean };

/** Dashboard-style table card: header row, rounded bordered table, dashed empty state. */
export function AccTable({ title, subtitle, actions, headers, children, foot, empty, className = "", compact }: {
  title: string; subtitle?: React.ReactNode; actions?: React.ReactNode; headers: Header[]; children?: React.ReactNode;
  foot?: React.ReactNode; empty?: string; className?: string; compact?: boolean;
}) {
  return <section className={`panel table-card acc-table-card ${className}`}>
    <div className="table-card-head">
      <div className="acc-card-title"><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
      {actions && <div className="table-card-actions">{actions}</div>}
    </div>
    {empty ? <div className="table-empty acc-empty"><Inbox size={22} aria-hidden /><strong>{empty}</strong></div>
      : <div className="table-scroll"><table className={`activity-table acc-table${compact ? " acc-table-compact" : ""}`}>
        <thead><tr>{headers.map((header) => {
          const { label, num, hidden } = typeof header === "string" ? { label: header } : header;
          return <th key={label} scope="col" className={num ? "acc-num" : undefined}>{hidden ? <span className="sr-only">{label}</span> : label}</th>;
        })}</tr></thead>
        <tbody>{children}</tbody>
        {foot && <tfoot>{foot}</tfoot>}
      </table></div>}
  </section>;
}

export function Num({ value, strong, className = "" }: { value: string; strong?: boolean; className?: string }) {
  return <td className={`acc-num ${className}`}>{strong ? <strong>{formatMoney(value)}</strong> : formatMoney(value)}</td>;
}

/** Compact filter card. Field names and labels match DateFilters so links and saved URLs keep working. */
export function AccFilters({ query, asOf, children, withSearch, dateLabel = "Reporting period" }: {
  query: Query; asOf?: string; children?: React.ReactNode; withSearch?: boolean; dateLabel?: string;
}) {
  const range = resolveRange(query);
  return <form className="panel acc-filters print-hide" method="get">
    <div className="acc-filters-title"><CalendarDays size={16} aria-hidden /><strong>{dateLabel}</strong></div>
    <div className="acc-filters-row">
      {asOf ? <label className="field">As of<input type="date" name="asOf" defaultValue={asOf} required /></label> : <>
        <label className="field">From<input type="date" name="from" defaultValue={range.from} required /></label>
        <label className="field">To<input type="date" name="to" defaultValue={range.to} required /></label>
      </>}
      {withSearch && <label className="field acc-field-grow">Search<input name="q" defaultValue={first(query.q) ?? ""} maxLength={100} /></label>}
      {children}
      <Button variant="outline" type="submit" className="acc-filter-submit"><Filter size={15} /> Apply filters</Button>
    </div>
    {!asOf && range.error && <p className="form-error" role="alert">{range.error}</p>}
  </form>;
}

export function StatCard({ icon, tone = "green", title, subtitle, value, aside, note, noteTone }: {
  icon: React.ReactNode; tone?: "green" | "blue" | "red" | "amber" | "slate"; title: string; subtitle?: string;
  value: React.ReactNode; aside?: React.ReactNode; note?: React.ReactNode; noteTone?: "good" | "bad";
}) {
  return <article className="stat-card acc-stat">
    <header><span className={`stat-icon ${["amber", "slate"].includes(tone) ? "acc-" : ""}tone-${tone}`} aria-hidden>{icon}</span>
      <div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div></header>
    <div className="stat-body"><p className="stat-value acc-stat-value">{value}</p>{aside && <div className="stat-change">{aside}</div>}</div>
    {note && <p className={`stat-note ${noteTone ?? ""}`}>{note}</p>}
  </article>;
}

/** A Dr/Cr balance with the side de-emphasised. Text content stays e.g. "6,000.00 Dr" for search and tests. */
export function SidedFigure({ value }: { value: string }) {
  return <span className={`acc-sided ${value.endsWith(" Cr") ? "acc-cr" : value.endsWith(" Dr") ? "acc-dr" : ""}`}>{value}</span>;
}
