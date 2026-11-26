import "server-only";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { AccessError, getActor } from "@/lib/auth";
import { requireCompany } from "@/lib/companies";

export async function accountingAccess(companyId: string) {
  const actor = await getActor();
  if (!actor) redirect("/workspace");
  if (!z.uuid().safeParse(companyId).success) notFound();
  const company = await requireCompany(actor, companyId, "view").catch((error: unknown) => {
    if (error instanceof AccessError) notFound();
    throw error;
  });
  return { actor, company, base: `/workspace/${companyId}/accounting` };
}
