import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { CompanyDetailsForm, MembersForm, RoleForms, YearForm } from "@/components/company-forms";
import { getActor } from "@/lib/auth";
import { companyDetails, companyList, companyMembersAndRoles } from "@/lib/companies";

export const metadata = { title: "Company settings" };

export default async function Settings({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  const actor = await getActor();
  if (!actor) redirect("/workspace");
  if (!z.uuid().safeParse(companyId).success) notFound();
  const company = (await companyList(actor)).find((entry) => entry.id === companyId);
  if (!company) notFound();
  const has = (permission: "manage_company" | "manage_users" | "manage_roles") => company.permissions.includes(permission);
  if (!has("manage_company") && !has("manage_users") && !has("manage_roles")) notFound();
  const [details, membership] = await Promise.all([
    has("manage_company") ? companyDetails(companyId) : null,
    has("manage_users") || has("manage_roles") ? companyMembersAndRoles(companyId) : null,
  ]);
  return <div className="page-stack">
    <div className="page-heading"><div><Link href="/workspace/administration" className="text-link">Company directory</Link><h1>{company.name}</h1><p className="muted">{company.active ? "Active company" : "Inactive company"}</p></div></div>
    {details && <CompanyDetailsForm company={company} settings={details.settings} />}
    {details && <div id="financial-years"><YearForm companyId={companyId} years={details.years} active={company.active} /></div>}
    {membership && has("manage_users") && <MembersForm companyId={companyId} members={membership[0]} roles={membership[1]} actorId={actor.id} />}
    {membership && has("manage_roles") && <RoleForms companyId={companyId} roles={membership[1]} allowed={company.permissions} />}
  </div>;
}
