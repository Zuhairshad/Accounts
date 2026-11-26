import { notFound, redirect } from "next/navigation";
import { RangeForm } from "@/components/range-form";
import { getActor } from "@/lib/auth";
import { combinedDashboard, companyList } from "@/lib/companies";
import { formatMoney } from "@/lib/display";
import { resolveRange, type Query } from "@/lib/range";

export const metadata = { title: "Combined reports" };

export default async function Combined({ searchParams }: { searchParams: Promise<Query> }) {
  const actor = await getActor();
  if (!actor) redirect("/workspace");
  const visible = (await companyList(actor))
    .filter((company) => company.active && company.permissions.includes("view") && company.permissions.includes("view_combined"));
  if (!visible.length) notFound();
  const range = resolveRange(await searchParams);
  const rows = await combinedDashboard(visible.map((company) => company.id), range);
  return <div className="page-stack">
    <div className="page-heading"><div><h1>Combined reports</h1><p className="muted">Posted ledger activity by company for the selected period.</p></div></div>
    <RangeForm key={`${range.from}:${range.to}`} range={range} />
    {range.error && <p className="form-error" role="alert">{range.error}</p>}
    <section className="panel data-panel"><div className="panel-heading"><h2>Company activity</h2></div><div className="table-scroll"><table><thead><tr>
      <th>Company</th><th>Posted vouchers</th><th>Debit (PKR)</th><th>Credit (PKR)</th>
    </tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td>{row.name}</td><td>{row.count}</td><td>{formatMoney(row.debit)}</td><td>{formatMoney(row.credit)}</td></tr>)}</tbody></table></div></section>
  </div>;
}
