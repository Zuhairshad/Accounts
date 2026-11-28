import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowDownLeft, ArrowUpRight, Building2, ReceiptText } from "lucide-react";
import { RangeForm } from "@/components/range-form";
import { getActor } from "@/lib/auth";
import { combinedDashboard, companyList } from "@/lib/companies";
import { formatMoney } from "@/lib/display";
import { Exact } from "@/lib/engine/model";
import { resolveRange, type Query } from "@/lib/range";
import { displayDate } from "@/lib/validation";

export const metadata = { title: "Combined reports" };

const avatars = ["avatar-green", "avatar-blue", "avatar-violet", "avatar-amber", "avatar-pink"];
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]).join("").toUpperCase();

export default async function Combined({ searchParams }: { searchParams: Promise<Query> }) {
  const actor = await getActor();
  if (!actor) redirect("/workspace");
  const visible = (await companyList(actor))
    .filter((company) => company.active && company.permissions.includes("view") && company.permissions.includes("view_combined"));
  if (!visible.length) notFound();
  const range = resolveRange(await searchParams);
  const rows = await combinedDashboard(visible.map((company) => company.id), range);
  // Display-only totals of the rows above; the figures themselves come straight from the query.
  const vouchers = rows.reduce((total, row) => total + Number(row.count), 0);
  const debit = rows.reduce((total, row) => total.plus(row.debit), new Exact(0)).toFixed(2);
  const credit = rows.reduce((total, row) => total.plus(row.credit), new Exact(0)).toFixed(2);
  const stats = [
    { title: "Companies", note: "Included in this view", value: String(rows.length), icon: Building2, tone: "tone-green" },
    { title: "Posted vouchers", note: "Across all companies", value: String(vouchers), icon: ReceiptText, tone: "tone-blue" },
    { title: "Total debit", note: "PKR, posted lines", value: formatMoney(debit), icon: ArrowUpRight, tone: "tone-green" },
    { title: "Total credit", note: "PKR, posted lines", value: formatMoney(credit), icon: ArrowDownLeft, tone: "tone-blue" },
  ];
  return <div className="page-stack rep-page">
    <div className="page-heading"><div><p className="eyebrow">All companies</p><h1>Combined reports</h1><p className="muted rep-sub">Posted ledger activity by company for the selected period.</p></div></div>
    <RangeForm key={`${range.from}:${range.to}`} range={range} />
    {range.error && <p className="form-error" role="alert">{range.error}</p>}
    <div className="rep-stats">{stats.map((stat) => <div key={stat.title} className="rep-stat">
      <span className={`stat-icon ${stat.tone}`} aria-hidden><stat.icon size={19} /></span>
      <div><span className="muted">{stat.title}</span><strong>{stat.value}</strong><small>{stat.note}</small></div>
    </div>)}</div>
    <section className="panel table-card rep-combined"><div className="table-card-head"><div><h2>Company activity</h2>
      <p className="muted rep-sub">{displayDate(range.from)} to {displayDate(range.to)}</p></div></div>
      <div className="table-scroll"><table className="rep-table"><thead><tr>
        <th>Company</th><th className="report-number">Posted vouchers</th><th className="report-number">Debit (PKR)</th><th className="report-number">Credit (PKR)</th>
      </tr></thead><tbody>{rows.map((row, index) => <tr key={row.id}>
        <td><div className="who"><span className={`avatar ${avatars[index % avatars.length]}`} aria-hidden>{initials(row.name)}</span>
          <Link className="rep-company-link" href={`/workspace/${row.id}`}>{row.name}</Link></div></td>
        <td className="report-number">{row.count}</td><td className="report-number">{formatMoney(row.debit)}</td><td className="report-number">{formatMoney(row.credit)}</td>
      </tr>)}</tbody></table></div></section>
  </div>;
}
