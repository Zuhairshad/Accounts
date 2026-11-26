import { createHash } from "node:crypto";
import { z } from "zod";
import { getDb } from "@/db";
import { AccessError,getActor } from "@/lib/auth";
import { lockActor,lockCompany,requireCompany } from "@/lib/companies";
import { idempotently } from "@/lib/accounting";
import { reasonText } from "@/lib/engine/model";
import { registerPayload } from "@/lib/reports/register";
import { registerWrite,RegisterConflict } from "@/lib/reports/register-write";
import { isRegister } from "@/lib/reports/model";
import type { Permission } from "@/lib/permissions";

const envelope=z.object({ id:z.uuid(),requestKey:z.uuid(),version:z.number().int().nonnegative(),
  operation:z.enum(["save","void","restore"]),payload:registerPayload.optional(),reason:reasonText.optional() });
const result=(message:string,status:number)=>Response.json({message},{status,headers:{"Cache-Control":"private, no-store"}});

export async function POST(request:Request,{params}:{params:Promise<{companyId:string;kind:string}>}) {
  const {companyId,kind}=await params;
  if (!z.uuid().safeParse(companyId).success || !isRegister(kind)) return result("Register unavailable.",404);
  if (request.headers.get("origin")!==new URL(process.env.NEXTAUTH_URL ?? request.url).origin) return result("Invalid request origin.",403);
  const actor=await getActor();
  if (!actor) return result("Sign in again to save.",401);
  const input=await request.text();
  if (input.length>13000) return result("Register row is too large.",413);
  let raw:unknown;
  try {raw=JSON.parse(input);} catch {return result("Invalid register row.",400);}
  const parsed=envelope.safeParse(raw);
  if (!parsed.success) return result(parsed.error.issues[0]?.message ?? "Invalid register row.",422);
  if (parsed.data.operation!=="save" && !parsed.data.reason) return result("Enter a reason.",422);
  const {requestKey,...data}=parsed.data;
  try {
    const saved=await getDb().transaction(async (tx)=>{
      await lockActor(tx,actor);
      await lockCompany(tx,companyId);
      const access=await requireCompany(actor,companyId,"view",tx);
      const require=(perm:Permission)=>{
        if (!access.permissions.includes(perm)) throw new AccessError();
      };
      const hash=createHash("sha256").update(JSON.stringify(data)).digest("hex");
      return idempotently(tx,{companyId,operation:`register.${kind}`,key:requestKey,actorId:actor.id,requestHash:hash},
        ()=>registerWrite(tx,{companyId,actorId:actor.id,require},{...data,kind}));
    });
    return Response.json(saved,{headers:{"Cache-Control":"private, no-store"}});
  } catch(error) {
    if (error instanceof RegisterConflict) return result(error.message,409);
    if (error instanceof AccessError) return result("You cannot change this register.",403);
    if (error instanceof Error && error.message.includes("request key cannot be reused")) return result("Conflict detected. Reload this row.",409);
    console.error("Register-save transaction failed");
    return result("The server could not confirm the save.",503);
  }
}
