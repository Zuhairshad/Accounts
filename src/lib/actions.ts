"use server";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, type Transaction } from "@/db";
import { companies, companyMembers, companyRoles, companySettings, financialYears, users } from "@/db/schema";
import { insertCompany } from "@/db/seed";
import { AccessError, requireActor, type Actor } from "./auth";
import { lockActor, lockCompany, logAudit, requireCompany } from "./companies";
import { hashPassword, verifyPassword } from "./password";
import type { Permission } from "./permissions";
import { companyNameSchema, companySettingsSchema, displayNameSchema, financialYearSchema, passwordSchema, roleSchema, usernameSchema, versionSchema } from "./validation";

export type ActionState = { status: "idle" | "saved" | "error"; message: string };
type Work = (tx: Transaction, actor: Actor) => Promise<void>;

const uuid = z.uuid();
const entries = (form: FormData) => Object.fromEntries(form.entries());

function pgCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  if ("code" in error && typeof error.code === "string") return error.code;
  return "cause" in error ? pgCode(error.cause) : undefined;
}

async function execute(work: Work, options: { password?: boolean; refresh?: boolean } = {}): Promise<ActionState> {
  try {
    const actor = await requireActor(options.password);
    await getDb().transaction(async (tx) => {
      await lockActor(tx, actor, options.password);
      await work(tx, actor);
    });
    if (options.refresh !== false) revalidatePath("/workspace", "layout");
    return { status: "saved", message: options.password ? "Password saved. Sign in with your new password." : "Saved." };
  } catch (error) {
    if (error instanceof AccessError) return { status: "error", message: error.message };
    if (error instanceof z.ZodError) return { status: "error", message: error.issues[0]?.message ?? "Check the submitted information." };
    const code = pgCode(error);
    if (code === "23505") return { status: "error", message: "A record with those details already exists." };
    if (code === "23P01") return { status: "error", message: "The date range overlaps an existing financial year." };
    console.error("Workspace write failed", code ?? "database or server error");
    return { status: "error", message: "The server could not confirm the save. Refresh before retrying." };
  }
}

export async function createCompany(_state: ActionState, form: FormData) {
  return execute(async (tx, actor) => {
    if (!actor.superAdmin) throw new AccessError();
    const company = await insertCompany(tx, companyNameSchema.parse(form.get("name")));
    await logAudit(tx, actor.id, "company.created", company.id);
  });
}

export async function saveCompany(_state: ActionState, form: FormData) {
  return execute(async (tx, actor) => {
    const companyId = uuid.parse(form.get("companyId"));
    const version = versionSchema.parse(form.get("version"));
    const { name, ...settings } = companySettingsSchema.parse(entries(form));
    await lockCompany(tx, companyId);
    await requireCompany(actor, companyId, "manage_company", tx, true);
    const [updated] = await tx.update(companies).set({ name, version: sql`${companies.version} + 1` })
      .where(and(eq(companies.id, companyId), eq(companies.version, version))).returning({ id: companies.id });
    if (!updated) throw new AccessError("This company changed. Refresh before editing again.");
    await tx.update(companySettings).set({ ...settings, logoUrl: settings.logoUrl || null }).where(eq(companySettings.companyId, companyId));
    await logAudit(tx, actor.id, "company.settings_updated", companyId, { previousVersion: version });
  });
}

export async function setCompanyStatus(_state: ActionState, form: FormData) {
  return execute(async (tx, actor) => {
    const companyId = uuid.parse(form.get("companyId"));
    const version = versionSchema.parse(form.get("version"));
    const active = z.enum(["true", "false"]).parse(form.get("active")) === "true";
    await lockCompany(tx, companyId);
    await requireCompany(actor, companyId, "manage_company", tx, true);
    const [updated] = await tx.update(companies).set({ active, version: sql`${companies.version} + 1` })
      .where(and(eq(companies.id, companyId), eq(companies.version, version))).returning({ id: companies.id });
    if (!updated) throw new AccessError("This company changed. Refresh before editing again.");
    await logAudit(tx, actor.id, active ? "company.activated" : "company.deactivated", companyId);
  });
}

export async function addYear(_state: ActionState, form: FormData) {
  return execute(async (tx, actor) => {
    const companyId = uuid.parse(form.get("companyId"));
    const year = financialYearSchema.parse(entries(form));
    await lockCompany(tx, companyId);
    await requireCompany(actor, companyId, "manage_company", tx);
    const [saved] = await tx.insert(financialYears).values({ companyId, ...year }).returning({ id: financialYears.id });
    await logAudit(tx, actor.id, "company.year_created", companyId, { yearId: saved.id });
  });
}

export async function provisionUser(_state: ActionState, form: FormData) {
  return execute(async (tx, actor) => {
    if (!actor.superAdmin) throw new AccessError();
    const username = usernameSchema.parse(form.get("username"));
    const displayName = displayNameSchema.parse(form.get("displayName"));
    const passwordHash = await hashPassword(passwordSchema.parse(form.get("password")));
    const result = await tx.execute<{ id: string }>(sql`
      INSERT INTO users (username, display_name, password_hash)
      VALUES (${username}, ${displayName}, ${passwordHash})
      RETURNING id
    `);
    await logAudit(tx, actor.id, "user.provisioned", undefined, { userId: result.rows[0].id });
  }, { refresh: false });
}

function assertDelegation(actor: Actor, actorPermissions: Permission[], delegated: Permission[]) {
  if (!actor.superAdmin && delegated.some((permission) => !actorPermissions.includes(permission))) {
    throw new AccessError("You can delegate permissions you hold for this company.");
  }
}

async function checkExistingMembership(tx: Transaction, actor: Actor, companyId: string, userId: string, allowed: Permission[]) {
  const [existing] = await tx.select({ permissions: companyRoles.permissions }).from(companyMembers)
    .innerJoin(companyRoles, and(eq(companyRoles.companyId, companyMembers.companyId), eq(companyRoles.id, companyMembers.roleId)))
    .where(and(eq(companyMembers.companyId, companyId), eq(companyMembers.userId, userId)));
  if (existing) assertDelegation(actor, allowed, existing.permissions);
}

export async function setMembership(_state: ActionState, form: FormData) {
  return execute(async (tx, actor) => {
    const companyId = uuid.parse(form.get("companyId"));
    const roleId = uuid.parse(form.get("roleId"));
    const username = usernameSchema.parse(form.get("username"));
    await lockCompany(tx, companyId);
    const company = await requireCompany(actor, companyId, "manage_users", tx, true);
    const [user] = await tx.select({ id: users.id }).from(users)
      .where(and(eq(users.username, username), eq(users.active, true), eq(users.superAdmin, false)));
    const [role] = await tx.select().from(companyRoles).where(and(eq(companyRoles.companyId, companyId), eq(companyRoles.id, roleId)));
    if (!user || !role) throw new AccessError("The user and role could not be assigned.");
    if (user.id === actor.id) throw new AccessError("Ask another authorized administrator to change your own access.");
    assertDelegation(actor, company.permissions, role.permissions);
    await checkExistingMembership(tx, actor, companyId, user.id, company.permissions);
    await tx.insert(companyMembers).values({ companyId, userId: user.id, roleId }).onConflictDoUpdate({
      target: [companyMembers.companyId, companyMembers.userId], set: { roleId },
    });
    await logAudit(tx, actor.id, "company.member_assigned", companyId, { userId: user.id, roleId });
  });
}

export async function removeMembership(_state: ActionState, form: FormData) {
  return execute(async (tx, actor) => {
    const companyId = uuid.parse(form.get("companyId"));
    const userId = uuid.parse(form.get("userId"));
    await lockCompany(tx, companyId);
    const company = await requireCompany(actor, companyId, "manage_users", tx, true);
    if (userId === actor.id) throw new AccessError("Ask another authorized administrator to change your own access.");
    await checkExistingMembership(tx, actor, companyId, userId, company.permissions);
    const [removed] = await tx.delete(companyMembers)
      .where(and(eq(companyMembers.companyId, companyId), eq(companyMembers.userId, userId))).returning();
    if (removed) await logAudit(tx, actor.id, "company.member_removed", companyId, { userId });
  });
}

export async function saveRole(_state: ActionState, form: FormData) {
  return execute(async (tx, actor) => {
    const companyId = uuid.parse(form.get("companyId"));
    const role = roleSchema.parse({ name: form.get("name"), permissions: form.getAll("permissions") });
    const rawRole = form.get("roleId");
    await lockCompany(tx, companyId);
    const company = await requireCompany(actor, companyId, "manage_roles", tx, true);
    assertDelegation(actor, company.permissions, role.permissions);
    if (!rawRole) {
      const [saved] = await tx.insert(companyRoles).values({ companyId, ...role }).returning({ id: companyRoles.id });
      await logAudit(tx, actor.id, "company.role_created", companyId, { roleId: saved.id });
      return;
    }
    const roleId = uuid.parse(rawRole);
    const version = versionSchema.parse(form.get("version"));
    const [existing] = await tx.select().from(companyRoles)
      .where(and(eq(companyRoles.companyId, companyId), eq(companyRoles.id, roleId), eq(companyRoles.version, version)));
    if (!existing) throw new AccessError("This role changed. Refresh before editing again.");
    assertDelegation(actor, company.permissions, existing.permissions);
    await tx.update(companyRoles).set({ ...role, version: sql`${companyRoles.version} + 1` })
      .where(and(eq(companyRoles.companyId, companyId), eq(companyRoles.id, roleId)));
    await logAudit(tx, actor.id, "company.role_updated", companyId, { roleId, previousPermissions: existing.permissions });
  });
}

export async function changePassword(_state: ActionState, form: FormData) {
  return execute(async (tx, actor) => {
    const current = z.string().min(1).max(128).parse(form.get("current"));
    const next = passwordSchema.parse(form.get("password"));
    if (next !== form.get("confirm")) throw new AccessError("The new passwords must match.");
    if (current === next) throw new AccessError("Choose a different password.");
    const [user] = await tx.select({ hash: users.passwordHash }).from(users).where(eq(users.id, actor.id));
    if (!await verifyPassword(current, user.hash)) throw new AccessError("Enter your current password.");
    const passwordHash = await hashPassword(next);
    await tx.update(users).set({ passwordHash, mustChangePassword: false, sessionVersion: sql`${users.sessionVersion} + 1` })
      .where(eq(users.id, actor.id));
    await logAudit(tx, actor.id, "user.password_changed");
  }, { password: true, refresh: false });
}
