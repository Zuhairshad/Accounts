import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, Building2, CircleCheck, CirclePause, History, Plus, Settings2, UserPlus } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { createCompany, provisionUser } from "@/lib/actions";
import { getActor } from "@/lib/auth";
import { companyList } from "@/lib/companies";

export const metadata = { title: "Company directory" };

const tints = ["green", "violet", "amber", "blue", "pink"];
const initials = (name: string) => name.split(/[\s/]+/).filter(Boolean).slice(0, 2).map((word) => word[0]).join("").toUpperCase();
const tint = (name: string) => tints[[...name].reduce((sum, char) => sum + char.charCodeAt(0), 0) % tints.length];

export default async function Administration() {
  const actor = await getActor();
  if (!actor) redirect("/workspace");
  const rows = await companyList(actor);
  const active = rows.filter((row) => row.active).length;
  return <div className="page-stack">
    <div className="page-heading"><div><p className="eyebrow">Administration</p><h1>Company directory</h1><p className="muted">Open a workspace or manage company access and settings.</p></div>
      {actor.superAdmin && <div className="adm-actions">
        <Link className="button button-outline" href="/workspace/administration/operations"><History size={16} aria-hidden /> Migration and recovery history</Link>
        <a className="button button-primary" href="#add-company"><Plus size={16} aria-hidden /> New company</a>
      </div>}</div>

    <section className="stat-row adm-stat-row" aria-label="Company summary">
      <article className="stat-card"><header><span className="stat-icon tone-green"><Building2 size={20} aria-hidden /></span>
        <div><h2>Total companies</h2><p>{actor.superAdmin ? "All companies in this installation" : "Companies assigned to you"}</p></div><span /></header>
        <div className="stat-body"><p className="stat-value">{rows.length}</p></div></article>
      <article className="stat-card"><header><span className="stat-icon tone-blue"><CircleCheck size={20} aria-hidden /></span>
        <div><h2>Active companies</h2><p>Open for posting and reporting</p></div><span /></header>
        <div className="stat-body"><p className="stat-value">{active}</p>{rows.length > 0 && <span className="pill pill-good">{Math.round(active / rows.length * 100)}%</span>}</div></article>
      <article className="stat-card"><header><span className="stat-icon tone-red"><CirclePause size={20} aria-hidden /></span>
        <div><h2>Inactive companies</h2><p>Read-only until reactivated</p></div><span /></header>
        <div className="stat-body"><p className="stat-value">{rows.length - active}</p></div></article>
    </section>

    <section className="panel table-card" aria-labelledby="companies-title">
      <div className="table-card-head"><div><h2 id="companies-title">Companies</h2><p className="adm-sub">{rows.length} compan{rows.length === 1 ? "y" : "ies"}</p></div></div>
      {rows.length ? <div className="table-scroll"><table className="activity-table adm-table adm-company-table"><thead><tr><th scope="col">Company</th><th scope="col">Status</th><th scope="col" className="adm-col-actions">Actions</th></tr></thead><tbody>
        {rows.map((row) => <tr key={row.id}><td><div className="who"><span className={`avatar avatar-${tint(row.name)}`} aria-hidden>{initials(row.name)}</span>
          <div><strong>{row.name}</strong><small>{row.permissions.length} permission{row.permissions.length === 1 ? "" : "s"}</small></div></div></td>
          <td><span className={`status ${row.active ? "status-posted" : "adm-status-muted"}`}>{row.active ? "Active" : "Inactive"}</span></td>
          <td className="adm-col-actions"><div className="adm-row-actions">
            {row.permissions.some((permission) => ["manage_company", "manage_users", "manage_roles"].includes(permission)) && <Button asChild variant="ghost" className="button-small"><a href={`/workspace/${row.id}/settings`}><Settings2 size={15} /> Manage</a></Button>}
            {row.active && row.permissions.includes("view") && <Button asChild variant="outline" className="button-small"><Link href={`/workspace/${row.id}`}>Open workspace <ArrowRight size={14} aria-hidden /></Link></Button>}
          </div></td></tr>)}
      </tbody></table></div> : <p className="table-empty">No companies assigned</p>}
    </section>

    {actor.superAdmin && <div className="admin-grid adm-form-pair">
      <section className="panel" id="add-company">
        <header className="adm-card-head"><span className="stat-icon tone-green"><Building2 size={20} aria-hidden /></span>
          <div><h2>Add company</h2><p className="muted">Creates the company with a default chart of accounts and roles.</p></div></header>
        <ActionForm action={createCompany} label="Create company" className="adm-card-form">
          <label className="field">Company name<input name="name" required maxLength={160} /></label>
        </ActionForm></section>
      <section className="panel">
        <header className="adm-card-head"><span className="stat-icon tone-blue"><UserPlus size={20} aria-hidden /></span>
          <div><h2>Provision user</h2><p className="muted">The user changes their initial password at first sign-in. Assign company access in the company’s settings.</p></div></header>
        <ActionForm action={provisionUser} label="Create user" className="adm-card-form">
          <div className="form-grid"><label className="field">Display name<input name="displayName" required maxLength={120} /></label>
            <label className="field">Username<input name="username" required maxLength={120} /></label>
            <label className="field field-wide">Initial password<input name="password" type="password" required minLength={15} maxLength={128} autoComplete="new-password" /></label></div>
        </ActionForm>
      </section>
    </div>}
  </div>;
}
