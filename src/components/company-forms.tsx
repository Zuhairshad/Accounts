import { Building2, CalendarRange, ChevronDown, ShieldCheck, Users } from "lucide-react";
import { ActionForm } from "./action-form";
import { addYear, removeMembership, saveCompany, saveRole, setCompanyStatus, setMembership } from "@/lib/actions";
import { permissions, type Permission } from "@/lib/permissions";
import { displayDate } from "@/lib/validation";
import type { companyRoles, companySettings, financialYears } from "@/db/schema";

type Role = typeof companyRoles.$inferSelect;
type Year = typeof financialYears.$inferSelect;
type Settings = typeof companySettings.$inferSelect;
type Member = { id: string; username: string; displayName: string; roleId: string };

const tints = ["green", "violet", "amber", "blue", "pink"];
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]).join("").toUpperCase();
const tint = (name: string) => tints[[...name].reduce((sum, char) => sum + char.charCodeAt(0), 0) % tints.length];

function CardHead({ icon, tone, title, children }: { icon: React.ReactNode; tone: string; title: string; children?: React.ReactNode }) {
  return <header className="adm-card-head"><span className={`stat-icon ${tone}`}>{icon}</span><div><h2>{title}</h2>{children && <p className="muted">{children}</p>}</div></header>;
}

export function CompanyDetailsForm({ company, settings }: { company: { id: string; name: string; version: number; active: boolean }; settings: Settings }) {
  return <section className="panel adm-card" id="company-profile">
    <CardHead icon={<Building2 size={20} aria-hidden />} tone="tone-green" title="Company profile">Name, contact details and document numbering printed on vouchers and invoices.</CardHead>
    <ActionForm action={saveCompany} label="Save settings" className="adm-card-form">
      <input type="hidden" name="companyId" value={company.id} /><input type="hidden" name="version" value={company.version} />
      <div className="form-grid adm-grid-3">
        <label className="field">Company name<input name="name" defaultValue={company.name} required maxLength={160} /></label>
        <label className="field">Phone<input name="phone" type="tel" defaultValue={settings.phone} maxLength={60} /></label>
        <label className="field">Email<input name="email" type="email" defaultValue={settings.email} maxLength={200} /></label>
        <label className="field field-wide">Address<textarea name="address" defaultValue={settings.address} maxLength={500} /></label>
        <label className="field">NTN<input name="ntn" defaultValue={settings.ntn} maxLength={60} /></label>
        <label className="field">STRN<input name="strn" defaultValue={settings.strn} maxLength={60} /></label>
        <label className="field">Logo HTTPS URL<input name="logoUrl" type="url" defaultValue={settings.logoUrl ?? ""} maxLength={500} /></label>
        <label className="field">Document prefix<input name="numberPrefix" defaultValue={settings.numberPrefix} maxLength={24} /></label>
        <label className="field">Document number digits<input name="numberPadding" type="number" min="1" max="10" defaultValue={settings.numberPadding} required /></label>
      </div>
      <dl className="settings-defaults adm-defaults"><div><dt>Currency</dt><dd>{settings.currency}</dd></div><div><dt>Business timezone</dt><dd>{settings.timezone}</dd></div><div><dt>Display date format</dt><dd>{settings.displayDateFormat}</dd></div></dl>
    </ActionForm>
    <div className="adm-status-row">
      <div><strong>Company status</strong><p className="muted">{company.active ? "Inactive companies cannot be opened as a workspace until activated again." : "Activate the company to resume posting."}</p></div>
      <ActionForm action={setCompanyStatus} label={company.active ? "Deactivate company" : "Activate company"} compact danger={company.active}>
        <input type="hidden" name="companyId" value={company.id} /><input type="hidden" name="version" value={company.version} />
        <input type="hidden" name="active" value={String(!company.active)} />
      </ActionForm>
    </div>
  </section>;
}

export function YearForm({ companyId, years, active }: { companyId: string; years: Year[]; active: boolean }) {
  return <section className="panel adm-card">
    <CardHead icon={<CalendarRange size={20} aria-hidden />} tone="tone-blue" title="Financial years">Reporting periods used by filters and reports.</CardHead>
    {years.length > 0 ? <ul className="adm-list">{years.map((year) => <li key={year.id}>
      <div className="adm-list-main"><strong>{year.name}</strong><small>{displayDate(year.startsOn)} to {displayDate(year.endsOn)}</small></div>
      <span className={`status ${year.closed ? "adm-status-muted" : "status-posted"}`}>{year.closed ? "Closed" : "Open"}</span></li>)}</ul>
      : <p className="table-empty adm-inset-empty">No financial years configured.</p>}
    {active && <ActionForm action={addYear} label="Add financial year" className="adm-card-form adm-subform">
      <input type="hidden" name="companyId" value={companyId} />
      <p className="adm-subform-title">Add a year</p>
      <div className="form-grid">
        <label className="field field-wide">Year name<input name="name" required maxLength={80} /></label>
        <label className="field">Start date<input name="startsOn" type="date" required /></label>
        <label className="field">End date<input name="endsOn" type="date" required /></label>
      </div>
    </ActionForm>}
  </section>;
}

export function MembersForm({ companyId, members, roles, actorId }: { companyId: string; members: Member[]; roles: Role[]; actorId: string }) {
  return <section className="panel adm-card" id="company-members">
    <CardHead icon={<Users size={20} aria-hidden />} tone="tone-green" title="Company members">Users who can open this company, and the role each one holds.</CardHead>
    {members.length > 0 ? <ul className="adm-list">{members.map((member) => <li key={member.id}>
      <div className="who"><span className={`avatar avatar-${tint(member.displayName)}`} aria-hidden>{initials(member.displayName)}</span>
        <div className="adm-list-main"><strong>{member.displayName}</strong><small>{member.username}</small></div></div>
      <div className="adm-list-side"><span className="tag">{roles.find((role) => role.id === member.roleId)?.name}</span>
        {actorId !== member.id && <ActionForm action={removeMembership} label="Remove access" compact>
          <input type="hidden" name="companyId" value={companyId} /><input type="hidden" name="userId" value={member.id} />
        </ActionForm>}</div>
    </li>)}</ul> : <p className="table-empty adm-inset-empty">No users assigned to this company.</p>}
    <ActionForm action={setMembership} label="Assign role" className="adm-card-form adm-subform">
      <input type="hidden" name="companyId" value={companyId} />
      <p className="adm-subform-title">Give a user access</p>
      <div className="form-grid">
        <label className="field">Existing username<input name="username" required maxLength={120} /></label>
        <label className="field">Role<select name="roleId" required defaultValue=""><option value="" disabled>Select role</option>{roles.map((role) => <option value={role.id} key={role.id}>{role.name}</option>)}</select></label>
      </div>
    </ActionForm>
  </section>;
}

export function RoleForms({ companyId, roles, allowed }: { companyId: string; roles: Role[]; allowed: Permission[] }) {
  return <section className="panel adm-card" id="company-roles">
    <CardHead icon={<ShieldCheck size={20} aria-hidden />} tone="tone-blue" title="Roles and permissions">Open a role to change what its members can do.</CardHead>
    <div className="adm-roles">
      {roles.map((role) => <details key={role.id} className="role-detail adm-role"><summary><span>{role.name}</span>
        <span className="adm-role-meta">{role.permissions.length} permission{role.permissions.length === 1 ? "" : "s"}<ChevronDown size={16} aria-hidden /></span></summary>
        {role.permissions.every((permission) => allowed.includes(permission)) ? <RoleForm companyId={companyId} role={role} allowed={allowed} /> :
          <p className="muted adm-role-body">{role.permissions.map((permission) => permission.replaceAll("_", " ")).join(", ")}</p>}
      </details>)}
      <details className="role-detail adm-role adm-role-new"><summary><span>Create role</span><ChevronDown size={16} aria-hidden /></summary><RoleForm companyId={companyId} allowed={allowed} /></details>
    </div>
  </section>;
}

function RoleForm({ companyId, role, allowed }: { companyId: string; role?: Role; allowed: Permission[] }) {
  return <ActionForm action={saveRole} label={role ? "Save role" : "Create role"} className="adm-role-body">
    <input type="hidden" name="companyId" value={companyId} />
    {role && <><input type="hidden" name="roleId" value={role.id} /><input type="hidden" name="version" value={role.version} /></>}
    <label className="field adm-role-name">Role name<input name="name" required maxLength={80} defaultValue={role?.name} /></label>
    <fieldset className="permission-grid adm-permissions"><legend>Permissions</legend>
      {permissions.filter((permission) => allowed.includes(permission)).map((permission) => <label key={permission}><input type="checkbox" name="permissions" value={permission} defaultChecked={role?.permissions.includes(permission)} /> {permission.replaceAll("_", " ")}</label>)}
    </fieldset>
  </ActionForm>;
}
