import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { AccessError, getActor } from "@/lib/auth";
import { requireCompany } from "@/lib/companies";
import { modules } from "@/lib/modules";

export const metadata = { title: "Accounting modules" };

export default async function Modules({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  const actor = await getActor();
  if (!actor) redirect("/workspace");
  if (!z.uuid().safeParse(companyId).success) notFound();
  const company = await requireCompany(actor, companyId, "view").catch((error: unknown) => {
    if (error instanceof AccessError) notFound();
    throw error;
  });
  const categories = [...new Set(modules.map((module) => module.category))];
  return <div className="page-stack">
    <div className="page-heading"><div><p className="eyebrow">{company.name}</p><h1>Accounting modules</h1><p className="muted">Open an accounting module for this company.</p></div></div>
    <div className="module-grid">{categories.map((category) => <section key={category} className="panel"><h2>{category}</h2>
      <ul className="module-list">{modules.filter((module) => module.category === category).map((module) => <li key={module.title}>{"path" in module && module.path && (module.path !== "vouchers/new" || company.permissions.includes("create"))
        ? <Link className="text-link" href={`/workspace/${companyId}/accounting/${module.path}`}>{module.title}</Link>
        : "tradePath" in module && module.tradePath && (module.tradePath !== "settings" || company.permissions.includes("manage_company"))
          ? <Link className="text-link" href={`/workspace/${companyId}/trade/${module.tradePath}`}>{module.title}</Link>
          : "reportPath" in module && module.reportPath && (!["company-wise","combined-parties"].includes(module.reportPath) || company.permissions.includes("view_combined"))
            ? <Link className="text-link" href={`/workspace/${companyId}/reports/${module.reportPath}`}>{module.title}</Link>
            : <><span>{module.title}</span><span className="tag">{"path" in module || "tradePath" in module || "reportPath" in module ? "Restricted" : "Planned"}</span></>}</li>)}</ul>
    </section>)}</div>
  </div>;
}
