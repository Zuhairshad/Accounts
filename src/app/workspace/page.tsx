import { redirect } from "next/navigation";
import Link from "next/link";
import { getActor } from "@/lib/auth";
import { companyList } from "@/lib/companies";

export default async function Workspace() {
  const actor = await getActor();
  if (!actor) redirect("/sign-in");
  const companies = await companyList(actor);
  const selected = companies.find((company) => company.active && company.permissions.includes("view"));
  if (selected) redirect(`/workspace/${selected.id}`);
  return <section className="panel"><h1>Company access</h1><p className="muted mt-3">Your account has no active company assignment.</p><Link href="/workspace/administration" className="text-link block mt-4">Company directory</Link></section>;
}
