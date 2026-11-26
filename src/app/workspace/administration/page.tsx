import Link from "next/link";
import { redirect } from "next/navigation";
import { Building2, Settings2 } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { createCompany, provisionUser } from "@/lib/actions";
import { getActor } from "@/lib/auth";
import { companyList } from "@/lib/companies";

export const metadata = { title: "Company directory" };

export default async function Administration() {
  const actor = await getActor();
  if (!actor) redirect("/workspace");
  const rows = await companyList(actor);
  return <div className="page-stack">
    <div className="page-heading"><div><h1>Company directory</h1><p className="muted">Open a workspace or manage company access and settings.</p></div></div>
    <section className="panel data-panel">
      <div className="panel-heading"><h2>Companies</h2></div>
      {rows.length ? <div className="table-scroll"><table><thead><tr><th>Company</th><th>Status</th><th>Actions</th></tr></thead><tbody>
        {rows.map((row) => <tr key={row.id}><td><div className="flex items-center gap-2"><Building2 size={18} /> <strong>{row.name}</strong></div></td>
          <td><span className={`tag ${row.active ? "tag-active" : ""}`}>{row.active ? "Active" : "Inactive"}</span></td>
          <td><div className="flex flex-wrap gap-2">
            {row.active && row.permissions.includes("view") && <Button asChild variant="outline"><Link href={`/workspace/${row.id}`}>Open workspace</Link></Button>}
            {row.permissions.some((permission) => ["manage_company", "manage_users", "manage_roles"].includes(permission)) && <Button asChild variant="ghost"><a href={`/workspace/${row.id}/settings`}><Settings2 size={17} /> Manage</a></Button>}
          </div></td></tr>)}
      </tbody></table></div> : <div className="empty"><strong>No companies assigned</strong></div>}
    </section>
    {actor.superAdmin && <div className="admin-grid">
      <section className="panel"><h2>Add company</h2><ActionForm action={createCompany} label="Create company" className="mt-5">
        <label className="field">Company name<input name="name" required maxLength={160} /></label>
      </ActionForm></section>
      <section className="panel"><h2>Provision user</h2><p className="muted mt-2">The user changes their initial password at first sign-in. Assign company access in the company’s settings.</p>
        <ActionForm action={provisionUser} label="Create user" className="mt-5">
          <div className="form-grid"><label className="field">Display name<input name="displayName" required maxLength={120} /></label>
            <label className="field">Username<input name="username" required maxLength={120} /></label>
            <label className="field field-wide">Initial password<input name="password" type="password" required minLength={15} maxLength={128} autoComplete="new-password" /></label></div>
        </ActionForm>
      </section>
    </div>}
  </div>;
}
