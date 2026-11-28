import Link from "next/link";
import { MoreVertical } from "lucide-react";

// Presentation helpers shared by the trade pages. They carry no accounting logic.

const tints = ["green", "violet", "amber", "blue", "pink"];
export const tint = (name: string) => tints[[...name].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % tints.length];
export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]).join("").toUpperCase() || "—";

export function Avatar({ name }: { name: string }) {
  return <span className={`avatar avatar-${tint(name)}`} aria-hidden>{initials(name)}</span>;
}

/** Header cell spec: a plain label, or a right-aligned numeric column. */
export type Header = string | { label: string; num?: boolean; hidden?: boolean };
export const num = (label: string): Header => ({ label, num: true });

export function TradeTable({ title, subtitle, headers, actions, empty, children, className = "" }: {
  title: string; subtitle?: React.ReactNode; headers: Header[]; actions?: React.ReactNode; empty?: string; children?: React.ReactNode; className?: string;
}) {
  return <section className={`panel table-card trade-table-card ${className}`}>
    <div className="table-card-head"><div><h2>{title}</h2>{subtitle && <p className="trade-subtitle">{subtitle}</p>}</div>
      {actions && <div className="table-card-actions">{actions}</div>}</div>
    {empty ? <p className="table-empty">{empty}</p> :
      <div className="table-scroll"><table className="activity-table trade-table"><thead><tr>{headers.map((header) => {
        const spec = typeof header === "string" ? { label: header } : header;
        return <th key={spec.label} scope="col" className={spec.num ? "trade-num" : undefined}>
          {spec.hidden ? <span className="sr-only">{spec.label}</span> : spec.label}</th>;
      })}</tr></thead><tbody>{children}</tbody></table></div>}
  </section>;
}

const tones: Record<string, string> = {
  posted: "good", active: "good", paid: "good", draft: "warn", "below reorder": "warn", partial: "warn", void: "bad", voided: "bad", inactive: "muted",
};
export function StatusPill({ status, label }: { status: string; label?: string }) {
  return <span className={`status trade-status trade-status-${tones[status.toLowerCase()] ?? "muted"}`}>{label ?? status}</span>;
}

export function RowMenu({ label, links }: { label: string; links: { label: string; href: string }[] }) {
  return <details className="card-menu trade-row-menu">
    <summary aria-label={label}><MoreVertical size={16} aria-hidden /></summary>
    <div className="card-menu-panel">{links.map((link) => <Link key={link.href + link.label} href={link.href}>{link.label}</Link>)}</div>
  </details>;
}

export function CardHead({ title, subtitle, children }: { title: string; subtitle?: React.ReactNode; children?: React.ReactNode }) {
  return <div className="trade-card-head"><div><h2>{title}</h2>{subtitle && <p className="trade-subtitle">{subtitle}</p>}</div>{children}</div>;
}
