import { ActionForm } from "./action-form";
import { addYear, removeMembership, saveCompany, saveRole, setCompanyStatus, setMembership } from "@/lib/actions";
import { permissions, type Permission } from "@/lib/permissions";
import { displayDate } from "@/lib/validation";
import type { companyRoles, companySettings, financialYears } from "@/db/schema";

type Role = typeof companyRoles.$inferSelect;
type Year = typeof financialYears.$inferSelect;
type Settings = typeof companySettings.$inferSelect;
type Member = { id: string; username: string; displayName: string; roleId: string };

export function CompanyDetailsForm({ company, settings }: { company: { id: string; name: string; version: number; active: boolean }; settings: Settings }) {
  return <section className="panel">
    <h2>Company profile</h2>
    <ActionForm action={saveCompany} label="Save settings" className="mt-5">
      <input type="hidden" name="companyId" value={company.id} /><input type="hidden" name="version" value={company.version} />
      <div className="form-grid">
        <label className="field">Company name<input name="name" defaultValue={company.name} required maxLength={160} /></label>
        <label className="field">Logo HTTPS URL<input name="logoUrl" type="url" defaultValue={settings.logoUrl ?? ""} maxLength={500} /></label>
        <label className="field field-wide">Address<textarea name="address" defaultValue={settings.address} maxLength={500} /></label>
        <label className="field">Phone<input name="phone" type="tel" defaultValue={settings.phone} maxLength={60} /></label>
        <label className="field">Email<input name="email" type="email" defaultValue={settings.email} maxLength={200} /></label>
        <label className="field">NTN<input name="ntn" defaultValue={settings.ntn} maxLength={60} /></label>
        <label className="field">STRN<input name="strn" defaultValue={settings.strn} maxLength={60} /></label>
        <label className="field">Document prefix<input name="numberPrefix" defaultValue={settings.numberPrefix} maxLength={24} /></label>
        <label className="field">Document number digits<input name="numberPadding" type="number" min="1" max="10" defaultValue={settings.numberPadding} required /></label>
      </div>
      <dl className="settings-defaults"><div><dt>Currency</dt><dd>{settings.currency}</dd></div><div><dt>Business timezone</dt><dd>{settings.timezone}</dd></div><div><dt>Display date format</dt><dd>{settings.displayDateFormat}</dd></div></dl>
    </ActionForm>
    <div className="divider mt-6">
      <ActionForm action={setCompanyStatus} label={company.active ? "Deactivate company" : "Activate company"} compact danger={company.active}>
        <input type="hidden" name="companyId" value={company.id} /><input type="hidden" name="version" value={company.version} />
        <input type="hidden" name="active" value={String(!company.active)} />
      </ActionForm>
    </div>
  </section>;
}

export function YearForm({ companyId, years, active }: { companyId: string; years: Year[]; active: boolean }) {
  return <section className="panel">
    <h2>Financial years</h2>
    {years.length > 0 ? <ul className="setting-list">{years.map((year) => <li key={year.id}><strong>{year.name}</strong><span>{displayDate(year.startsOn)} to {displayDate(year.endsOn)}</span><small>{year.closed ? "Closed" : "Open"}</small></li>)}</ul> : <p className="muted mt-3">No financial years configured.</p>}
    {active && <ActionForm action={addYear} label="Add financial year" className="mt-5">
      <input type="hidden" name="companyId" value={companyId} />
      <div className="form-grid">
        <label className="field field-wide">Year name<input name="name" required maxLength={80} /></label>
        <label className="field">Start date<input name="startsOn" type="date" required /></label>
        <label className="field">End date<input name="endsOn" type="date" required /></label>
      </div>
    </ActionForm>}
  </section>;
}

export function MembersForm({ companyId, members, roles, actorId }: { companyId: string; members: Member[]; roles: Role[]; actorId: string }) {
  return <section className="panel">
    <h2>Company members</h2>
    {members.length > 0 ? <ul className="setting-list">{members.map((member) => <li key={member.id}>
      <div><strong>{member.displayName}</strong><small>{member.username}</small></div><span>{roles.find((role) => role.id === member.roleId)?.name}</span>
      {actorId !== member.id && <ActionForm action={removeMembership} label="Remove access" compact>
        <input type="hidden" name="companyId" value={companyId} /><input type="hidden" name="userId" value={member.id} />
      </ActionForm>}
    </li>)}</ul> : <p className="muted mt-3">No users assigned to this company.</p>}
    <ActionForm action={setMembership} label="Assign role" className="mt-5">
      <input type="hidden" name="companyId" value={companyId} />
      <div className="form-grid">
        <label className="field">Existing username<input name="username" required maxLength={120} /></label>
        <label className="field">Role<select name="roleId" required defaultValue=""><option value="" disabled>Select role</option>{roles.map((role) => <option value={role.id} key={role.id}>{role.name}</option>)}</select></label>
      </div>
    </ActionForm>
  </section>;
}

export function RoleForms({ companyId, roles, allowed }: { companyId: string; roles: Role[]; allowed: Permission[] }) {
  return <section className="panel">
    <h2>Roles and permissions</h2>
    {roles.map((role) => <details key={role.id} className="role-detail"><summary>{role.name}</summary>
      {role.permissions.every((permission) => allowed.includes(permission)) ? <RoleForm companyId={companyId} role={role} allowed={allowed} /> :
        <p className="muted mt-3">{role.permissions.map((permission) => permission.replaceAll("_", " ")).join(", ")}</p>}
    </details>)}
    <details className="role-detail"><summary>Create role</summary><RoleForm companyId={companyId} allowed={allowed} /></details>
  </section>;
}

function RoleForm({ companyId, role, allowed }: { companyId: string; role?: Role; allowed: Permission[] }) {
  return <ActionForm action={saveRole} label={role ? "Save role" : "Create role"} className="mt-4">
    <input type="hidden" name="companyId" value={companyId} />
    {role && <><input type="hidden" name="roleId" value={role.id} /><input type="hidden" name="version" value={role.version} /></>}
    <label className="field">Role name<input name="name" required maxLength={80} defaultValue={role?.name} /></label>
    <fieldset className="permission-grid"><legend className="font-semibold mb-2">Permissions</legend>
      {permissions.filter((permission) => allowed.includes(permission)).map((permission) => <label key={permission}><input type="checkbox" name="permissions" value={permission} defaultChecked={role?.permissions.includes(permission)} /> {permission.replaceAll("_", " ")}</label>)}
    </fieldset>
  </ActionForm>;
}
