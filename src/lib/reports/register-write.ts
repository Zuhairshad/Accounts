import { and,eq,sql } from "drizzle-orm";
import type { Transaction } from "@/db";
import { auditLogs,deletedRecords,manualRegisterRows,parties,revisions,restorationHistory } from "@/db/schema";
import { isComplete,type RegisterPayload } from "./register";
import type { RegisterId } from "./model";

export class RegisterConflict extends Error {}
type Result = { id:string;version:number;status:string };
type Kind = "save" | "void" | "restore";
type Context = {companyId:string;actorId:string;require:(permission:"create"|"edit"|"delete"|"restore")=>void};
export type RegisterChange = { id:string;version:number;kind:RegisterId;operation:Kind;payload?:RegisterPayload;reason?:string };

export async function registerWrite(tx:Transaction,context:Context,input:RegisterChange):Promise<Result> {
  const {companyId,actorId}=context;
  const [old]=await tx.select().from(manualRegisterRows).where(and(eq(manualRegisterRows.companyId,companyId),
    eq(manualRegisterRows.id,input.id),eq(manualRegisterRows.register,input.kind))).for("update");
  if ((old?.version ?? 0)!==input.version || old?.status==="linked") throw new RegisterConflict("Conflict detected. Reload the saved row before trying again.");
  let result:typeof manualRegisterRows.$inferSelect;
  if (input.operation==="save") {
    context.require(old ? "edit" : "create");
    if (!input.payload || old?.status==="void") throw new RegisterConflict("This row is voided or no longer available.");
    if (input.payload.partyId) {
      const [party]=await tx.select({id:parties.id}).from(parties).where(and(eq(parties.companyId,companyId),eq(parties.id,input.payload.partyId)));
      if (!party) throw new RegisterConflict("Choose a party in this company.");
    }
    const values={ date:input.payload.date || null,payload:input.payload,status:isComplete(input.kind,input.payload) ? "saved" : "draft" };
    [result]=old ? await tx.update(manualRegisterRows).set({...values,version:old.version+1}).where(eq(manualRegisterRows.id,input.id)).returning()
      : await tx.insert(manualRegisterRows).values({...values,id:input.id,companyId,register:input.kind,createdBy:actorId}).returning();
  } else {
    context.require(input.operation==="void" ? "delete" : "restore");
    if (!old || (input.operation==="void")===(old.status==="void")) throw new RegisterConflict("This row is already in that state.");
    [result]=await tx.update(manualRegisterRows).set({status:input.operation==="void" ? "void" : isComplete(input.kind,old.payload as RegisterPayload) ? "saved" : "draft",
      version:old.version+1}).where(eq(manualRegisterRows.id,input.id)).returning();
    if (input.operation==="void") await tx.insert(deletedRecords).values({companyId,entityType:"register",entityId:input.id,reason:input.reason!,deletedBy:actorId});
    else {
      const last=await tx.execute<{id:string}>(sql`SELECT d.id FROM deleted_records d WHERE d.company_id=${companyId}
        AND d.entity_type='register' AND d.entity_id=${input.id} AND NOT EXISTS(
          SELECT 1 FROM restoration_history r WHERE r.company_id=d.company_id AND r.deletion_id=d.id)
        ORDER BY d.deleted_at DESC,d.id DESC LIMIT 1`);
      if (!last.rows.length) throw new RegisterConflict("There is no deletion to restore.");
      await tx.insert(restorationHistory).values({companyId,deletionId:last.rows[0].id,restoredBy:actorId,reason:input.reason!});
    }
  }
  await tx.insert(revisions).values({companyId,entityType:"register",entityId:result.id,version:result.version,actorId,
    previousData:old ?? {},nextData:result,reason:input.reason ?? "Register autosave"});
  if (input.operation!=="save") await tx.insert(auditLogs).values({companyId,actorId,action:`register.${input.operation}`,data:{id:result.id,reason:input.reason}});
  return {id:result.id,version:result.version,status:result.status};
}
