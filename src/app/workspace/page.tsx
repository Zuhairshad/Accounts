import { redirect } from "next/navigation";
import Link from "next/link";
import { Building2 } from "lucide-react";
import { getActor } from "@/lib/auth";
import { companyList } from "@/lib/companies";

export default async function Workspace() {
  const actor = await getActor();
  if (!actor) redirect("/sign-in");
  const companies = await companyList(actor);
  const selected = companies.find((company) => company.active && company.permissions.includes("view"));
  if (selected) redirect(`/workspace/${selected.id}`);
  return <section className="panel adm-state adm-state-inline">
    <span className="stat-icon tone-blue"><Building2 size={22} aria-hidden /></span>
    <h1>Company access</h1>
    <p className="muted">Your account has no active company assignment.</p>
    <Link href="/workspace/administration" className="button button-outline">Company directory</Link>
  </section>;
}
