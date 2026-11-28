import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { CalendarDays, CircleAlert, CircleCheck, TriangleAlert } from "lucide-react";
import { getDb } from "@/db";
import { DateFilters, PageHeading } from "@/components/accounting/finance-ui";
import { reconcile, type Check } from "@/lib/audit/reconcile";
import { AccessError, getActor } from "@/lib/auth";
import { requireCompany } from "@/lib/companies";
import { formatMoney } from "@/lib/display";
import { resolveRange, type Query } from "@/lib/range";
import { displayDate } from "@/lib/validation";

export const metadata = { title: "Financial reconciliation" };
export const dynamic = "force-dynamic";

const icon = { pass: CircleCheck, review: TriangleAlert, fail: CircleAlert } as const;
const label = { pass: "Reconciled", review: "Review", fail: "Discrepancy" } as const;
const tone = { pass: "tone-green", review: "rep-tone-amber", fail: "tone-red" } as const;

function CheckPanel({ check }: { check: Check }) {
  const Icon = icon[check.status];
  return <section className={`panel rep-check rep-check-${check.status}${check.findings.length ? " rep-check-wide" : ""}`} aria-labelledby={`check-${check.key}`}>
    <div className="reconcile-heading rep-check-head">
      <span className={`rep-check-icon ${tone[check.status]}`} aria-hidden><Icon size={17} /></span>
      <h2 id={`check-${check.key}`}>{check.title}</h2>
      <span className={`tag tag-${check.status}`}>{label[check.status]}</span>
    </div>
    <p className="muted rep-check-summary">{check.summary}</p>
    {check.expected !== undefined && <dl className="rep-figures">
      <div><dt>Expected</dt><dd className="money-cell">{formatMoney(check.expected)}</dd></div>
      <div><dt>Actual</dt><dd className="money-cell">{formatMoney(check.actual ?? "0")}</dd></div>
      <div><dt>Difference</dt><dd className="money-cell">{formatMoney(check.difference ?? "0")}</dd></div>
    </dl>}
    {check.findings.length > 0 && <div className="table-scroll rep-box"><table className="rep-table">
      <caption className="sr-only">Records affecting {check.title}</caption>
      <thead><tr><th scope="col">Record</th><th scope="col">Detail</th><th scope="col" className="money-cell">Amount</th></tr></thead>
      <tbody>{check.findings.map((finding, index) => <tr key={`${finding.label}-${index}`}>
        <td>{finding.href ? <Link className="text-link" href={finding.href}>{finding.label}</Link> : finding.label}</td>
        <td>{finding.note}</td><td className="money-cell">{finding.amount ? formatMoney(finding.amount) : ""}</td>
      </tr>)}</tbody></table></div>}
    {check.truncated > 0 && <p className="muted rep-check-summary">{check.truncated} further records are not shown. Narrow the date range to review them.</p>}
  </section>;
}

export default async function Reconciliation({ params, searchParams }: { params: Promise<{ companyId: string }>; searchParams: Promise<Query> }) {
  const [{ companyId }, query] = await Promise.all([params, searchParams]);
  const actor = await getActor();
  if (!actor) redirect("/workspace");
  if (!z.uuid().safeParse(companyId).success) notFound();
  // Reconciliation exposes company-wide balances and discrepancy detail, so it requires the export permission
  // (Accountant, Accounts Manager, Company Admin and Viewer / Auditor roles) in addition to view.
  const company = await requireCompany(actor, companyId, "export").catch((error: unknown) => {
    if (error instanceof AccessError) notFound();
    throw error;
  });
  const range = resolveRange(query);
  const result = range.error ? null : await getDb().transaction((tx) => reconcile(tx, companyId, range),
    { isolationLevel: "repeatable read", accessMode: "read only" });
  const total = (status: Check["status"]) => (result?.checks.filter((c) => c.status === status).length ?? 0);
  return <div className="page-stack rep-page">
    <PageHeading title="Financial reconciliation" company={company.name} />
    <p className="muted rep-lede">Each check recomputes balances directly from posted journal, stock and invoice records and compares them with
      the control accounts and reports. Nothing on this page changes records. Correct a discrepancy through the linked voucher,
      invoice or adjustment so the correction is approved and audited.</p>
    <div className="rep-recon-filters"><DateFilters query={query} dateLabel="Reconciliation period" /></div>
    {result && <>
      <div className="rep-stats" role="status">
        <div className="rep-stat"><span className="stat-icon tone-red" aria-hidden><CircleAlert size={19} /></span>
          <div><span className="muted">Discrepancies</span><strong>{total("fail")}</strong></div></div>
        <div className="rep-stat"><span className="stat-icon rep-tone-amber" aria-hidden><TriangleAlert size={19} /></span>
          <div><span className="muted">Needs review</span><strong>{total("review")}</strong></div></div>
        <div className="rep-stat"><span className="stat-icon tone-green" aria-hidden><CircleCheck size={19} /></span>
          <div><span className="muted">Reconciled</span><strong>{total("pass")}</strong></div></div>
        <div className="rep-stat"><span className="stat-icon tone-blue" aria-hidden><CalendarDays size={19} /></span>
          <div><span className="muted">Period</span><strong><small>{displayDate(result.from)} to {displayDate(result.to)}</small></strong></div></div>
      </div>
      <div className="rep-checks">{[...result.checks].sort((a, b) => ["fail", "review", "pass"].indexOf(a.status) - ["fail", "review", "pass"].indexOf(b.status))
        .map((check) => <CheckPanel key={check.key} check={check} />)}</div>
    </>}
  </div>;
}
