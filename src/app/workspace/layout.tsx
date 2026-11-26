import { and, desc, eq, inArray } from "drizzle-orm";
import { redirect } from "next/navigation";
import { WorkspaceShell } from "@/components/workspace-shell";
import { getDb } from "@/db";
import { auditLogs } from "@/db/schema";
import { getActor } from "@/lib/auth";
import { companyList } from "@/lib/companies";

export const dynamic = "force-dynamic";

const messages: Record<string, string> = {
  "company.created": "Company created",
  "company.settings_updated": "Company settings saved",
  "company.activated": "Company activated",
  "company.deactivated": "Company deactivated",
  "company.year_created": "Financial year added",
  "company.member_assigned": "Company access updated",
  "company.member_removed": "Company access removed",
  "company.role_created": "Company role created",
  "company.role_updated": "Company role updated",
  "user.password_changed": "Your password was changed",
};

export default async function Layout({ children }: { children: React.ReactNode }) {
  const actor = await getActor(true);
  if (!actor) redirect("/sign-in");
  if (actor.mustChangePassword) redirect("/password");
  const companies = await companyList(actor);
  const visible = companies.filter((company) => company.permissions.includes("view"));
  const manageable = companies.filter((company) => company.permissions.some((permission) => ["manage_company", "manage_roles", "manage_users"].includes(permission))).map((company) => company.id);
  const rows = await getDb().select({ id: auditLogs.id, action: auditLogs.action, date: auditLogs.createdAt })
    .from(auditLogs).where(and(eq(auditLogs.actorId, actor.id), inArray(auditLogs.action, Object.keys(messages))))
    .orderBy(desc(auditLogs.createdAt)).limit(5);
  return <WorkspaceShell
    actor={{ name: actor.displayName, username: actor.username, superAdmin: actor.superAdmin }}
    companies={visible} manageable={manageable}
    showCombined={visible.some((company) => company.active && company.permissions.includes("view_combined"))}
    notices={rows.map((row) => ({ id: row.id, description: messages[row.action], date: row.date.toLocaleDateString("en-GB", { timeZone: "Asia/Karachi" }).replaceAll("/", "-") }))}
  >{children}</WorkspaceShell>;
}
