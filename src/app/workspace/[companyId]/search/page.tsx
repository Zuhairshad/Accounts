import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { AccessError, getActor } from "@/lib/auth";
import { requireCompany, searchCompany } from "@/lib/companies";
import { first, type Query } from "@/lib/range";

export const metadata = { title: "Search" };

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
  return <div className="page-stack"><div className="page-heading"><div><p className="eyebrow">{company.name}</p><h1>Search company records</h1></div></div>
    <section className="panel"><h2>{query ? `Results for “${query}”` : "Enter a search term"}</h2>
      {rows.length ? <ul className="setting-list">{rows.map((row) => <li key={`${row.kind}:${row.id}`}>{row.path ? <Link className="text-link" href={`/workspace/${companyId}/${row.path}/${row.id}`}>{row.name}</Link> : <strong>{row.name}</strong>}<span className="capitalize">{row.kind.replaceAll("_", " ")}</span></li>)}</ul> :
        query && <p className="muted mt-3">No matching records.</p>}
    </section></div>;
}
