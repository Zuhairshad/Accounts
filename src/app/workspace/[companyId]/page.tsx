import Link from "next/link";
import { Activity, BookOpenCheck, Building2, CircleArrowDown, CircleArrowUp, Plus } from "lucide-react";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { LedgerTable } from "@/components/ledger-table";
import { RangeForm } from "@/components/range-form";
import { Button } from "@/components/ui/button";
import { AccessError, getActor } from "@/lib/auth";
import { companyDetails, dashboard, requireCompany } from "@/lib/companies";
import { formatMoney } from "@/lib/display";
import { first, resolveRange, type Query } from "@/lib/range";
import { displayDate } from "@/lib/validation";

export const metadata = { title: "Overview" };

export default async function CompanyPage({ params, searchParams }: { params: Promise<{ companyId: string }>; searchParams: Promise<Query> }) {
  const { companyId } = await params;
  const actor = await getActor();
  if (!actor) redirect("/workspace");
  if (!z.uuid().safeParse(companyId).success) notFound();
  const company = await requireCompany(actor, companyId, "view").catch((error: unknown) => {
    if (error instanceof AccessError) notFound();
    throw error;
  });
  const [{ settings, years }, query] = await Promise.all([companyDetails(companyId), searchParams]);
  const selected = years.find((year) => year.id === first(query.year));
  const range = resolveRange(query, selected);
  const data = await dashboard(companyId, range);
  const base = `/workspace/${companyId}`;

  return <div className="page-stack">
    <div className="page-heading">
      <div><p className="eyebrow"><Building2 size={16} /> {company.name}</p><h1>Accounting overview</h1><p className="muted">Posted activity for the selected company and reporting period.</p></div>
      <Button asChild variant="outline"><Link href={`${base}/modules`}><BookOpenCheck size={17} /> Browse modules</Link></Button>
    </div>
    <RangeForm key={`${selected?.id}:${range.from}:${range.to}`} years={years} current={selected?.id} range={range} />
    {range.error && <p role="alert" className="form-error">{range.error}</p>}
    <div className="stats-grid">
      <Stat icon={<Activity size={21} />} title="Posted vouchers" value={data.count} shade="blue" />
      <Stat icon={<CircleArrowDown size={21} />} title="Total debits" value={formatMoney(data.debit)} unit={settings.currency} shade="aqua" />
      <Stat icon={<CircleArrowUp size={21} />} title="Total credits" value={formatMoney(data.credit)} unit={settings.currency} shade="indigo" />
    </div>
    <section className="panel data-panel">
      <div className="panel-heading"><div><h2>Recent posted vouchers</h2><p className="muted">{displayDate(range.from)} to {displayDate(range.to)}</p></div></div>
      <LedgerTable data={data.recent} />
    </section>
    {!years.length && company.permissions.includes("manage_company") && <div className="setup-callout">
      <div><strong>Set up your financial year</strong><p className="muted">Configure company dates to use the financial year selector.</p></div>
      <Button asChild variant="outline"><a href={`${base}/settings#financial-years`}><Plus size={17} /> Add financial year</a></Button>
    </div>}
  </div>;
}

function Stat({ icon, title, value, unit, shade }: { icon: React.ReactNode; title: string; value: string; unit?: string; shade: string }) {
  return <div className="panel stat"><span className={`stat-icon ${shade}`}>{icon}</span><span className="muted">{title}</span><strong>{value} {unit && <small>{unit}</small>}</strong></div>;
}
