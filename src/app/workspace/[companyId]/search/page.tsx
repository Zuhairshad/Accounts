import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { BookOpen, ChevronRight, FileText, Receipt, Search as SearchIcon, Users } from "lucide-react";
import { AccessError, getActor } from "@/lib/auth";
import { requireCompany, searchCompany } from "@/lib/companies";
import { first, type Query } from "@/lib/range";

export const metadata = { title: "Search" };

/** Presentation only: the record group each search path belongs to. */
const groups: Record<string, { label: string; icon: typeof BookOpen; tone: string }> = {
  "accounting/chart": { label: "Account", icon: BookOpen, tone: "tone-green" },
  "accounting/parties": { label: "Party", icon: Users, tone: "tone-blue" },
  "accounting/vouchers": { label: "Voucher", icon: FileText, tone: "adm-tone-violet" },
  "trade/invoices": { label: "Invoice", icon: Receipt, tone: "adm-tone-amber" },
};

export default async function Search({ params, searchParams }: { params: Promise<{ companyId: string }>; searchParams: Promise<Query> }) {
  const { companyId } = await params;
  const actor = await getActor();
  if (!actor) redirect("/workspace");
  if (!z.uuid().safeParse(companyId).success) notFound();
  const company = await requireCompany(actor, companyId, "view").catch((error: unknown) => {
    if (error instanceof AccessError) notFound();
    throw error;
  });
  const query = (first((await searchParams).q) ?? "").trim().slice(0, 100);
  const rows = query ? await searchCompany(companyId, query) : [];
  return <div className="page-stack"><div className="page-heading"><div><p className="eyebrow">{company.name}</p><h1>Search company records</h1>
    <p className="muted">Accounts, customers and suppliers, vouchers and posted invoices.</p></div></div>
    <section className="panel table-card" aria-labelledby="search-title">
      <div className="table-card-head"><h2 id="search-title">{query ? `Results for “${query}”` : "Enter a search term"}</h2>
        {query && <span className="pill">{rows.length} record{rows.length === 1 ? "" : "s"}</span>}</div>
      {rows.length ? <div className="table-scroll"><table className="activity-table adm-table"><thead><tr><th scope="col">Record</th><th scope="col">Group</th><th scope="col">Type</th><th scope="col"><span className="sr-only">Open</span></th></tr></thead>
        <tbody>{rows.map((row) => {
          const group = (row.path && groups[row.path]) || { label: "Record", icon: FileText, tone: "adm-tone-slate" };
          const Icon = group.icon;
          return <tr key={`${row.kind}:${row.id}`}>
            <td><div className="who"><span className={`adm-row-icon ${group.tone}`}><Icon size={16} aria-hidden /></span>
              {row.path ? <Link className="adm-record-link" href={`/workspace/${companyId}/${row.path}/${row.id}`}>{row.name}</Link> : <strong>{row.name}</strong>}</div></td>
            <td><span className="adm-muted-cell">{group.label}</span></td>
            <td><span className="tag capitalize">{row.kind.replaceAll("_", " ")}</span></td>
            <td className="adm-col-actions">{row.path && <ChevronRight size={16} className="adm-chevron" aria-hidden />}</td>
          </tr>;
        })}</tbody></table></div>
        : <div className="table-empty adm-empty"><SearchIcon size={22} aria-hidden />{query ? <p>No matching records.</p> : <p>Use the search box at the top of the page to find records in this company.</p>}</div>}
    </section></div>;
}
