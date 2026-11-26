import "server-only";
import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, type Transaction } from "@/db";
import { AccessError, requireActor } from "@/lib/auth";
import { lockActor, lockCompany, requireCompany } from "@/lib/companies";
import { idempotently } from "@/lib/accounting";
import type { Permission } from "@/lib/permissions";
import type { FinanceContext } from "./vouchers";
import { AccountingError } from "./model";
export type FinanceState = { status: "idle" | "saved" | "error"; message: string; id?: string; retry?: boolean };
type Result = { id?: string; remaining?: string };
type Task<T> = (tx: Transaction, context: FinanceContext, data: T, require: (permission: Permission) => void) => Promise<Result>;

export const identifier = z.uuid();
export const optionalId = z.uuid().optional();
export const version = z.coerce.number().int().min(0);
export const entries = (form: FormData) => Object.fromEntries(form.entries());
export const bool = z.enum(["true", "false"]).transform((value) => value === "true");
export function readJson(value: FormDataEntryValue | null, maxLength = 120000): unknown {
  if (typeof value !== "string" || value.length > maxLength) throw new AccountingError("The submitted data is invalid.");
  try { return JSON.parse(value); } catch { throw new AccountingError("The submitted data is invalid."); }
}

function databaseCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if ("code" in error && typeof error.code === "string") return error.code;
  return "cause" in error ? databaseCode(error.cause) : undefined;
}

export async function run<T>(form: FormData, operation: string, data: () => T, task: Task<T>): Promise<FinanceState> {
  try {
    const actor = await requireActor();
    const companyId = identifier.parse(form.get("companyId"));
    const key = identifier.parse(form.get("requestKey"));
    const payload = data();
    const requestHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const result = await getDb().transaction(async (tx) => {
      await lockActor(tx, actor);
      await lockCompany(tx, companyId);
      const access = await requireCompany(actor, companyId, "view", tx);
      const require = (permission: Permission) => {
        if (!access.permissions.includes(permission)) throw new AccessError();
      };
      return idempotently(tx, { companyId, operation, key, actorId: actor.id, requestHash },
        () => task(tx, { companyId, actorId: actor.id, require }, payload, require));
    });
    revalidatePath(`/workspace/${companyId}`, "page");
    revalidatePath("/workspace/[companyId]/accounting/[section]", "page");
    revalidatePath("/workspace/[companyId]/accounting/[section]/[id]", "page");
    revalidatePath("/workspace/[companyId]/trade/[section]", "page");
    revalidatePath("/workspace/[companyId]/trade/[section]/[id]", "page");
    revalidatePath("/workspace/[companyId]/reports/[report]", "page");
    return { status: "saved", message: result.remaining && result.remaining !== "0.00" ? `Saved. PKR ${result.remaining} remains unallocated.` : "Saved.", id: result.id };
  } catch (error) {
    if (error instanceof AccountingError || error instanceof AccessError) return { status: "error", message: error.message };
    if (error instanceof z.ZodError) return { status: "error", message: error.issues[0]?.message ?? "Check the submitted fields." };
    const code = databaseCode(error);
    if (code === "23505") return { status: "error", message: "A record with these details already exists." };
    if (code === "22003") return { status: "error", message: "A quantity or amount exceeds the supported numeric range." };
    if (code === "23P01") return { status: "error", message: "Dates overlap an existing accounting period." };
    if (code === "23514" || code === "23503") return { status: "error", message: "The change violates a posting, date or account integrity rule." };
    if (error instanceof Error && error.message === "This request key cannot be reused for different work.") {
      return { status: "error", message: "A prior request with this key already committed different values. Reload to check the saved record." };
    }
    console.error("Accounting transaction failed", code ?? "connection or server error");
    return { status: "error", message: "The server could not confirm the save. Retry with the same values or refresh to check whether it committed.", retry: true };
  }
}
