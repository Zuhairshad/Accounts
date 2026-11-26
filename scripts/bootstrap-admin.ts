import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { auditLogs, companies, users } from "../src/db/schema";
import { insertCompany, starterCompanies } from "../src/db/seed";
import { hashPassword } from "../src/lib/password";
import { displayNameSchema, passwordSchema, usernameSchema } from "../src/lib/validation";

async function bootstrap() {
  const username = usernameSchema.parse(process.argv[2]);
  const displayName = displayNameSchema.parse(process.argv[3]);
  if (process.stdin.isTTY) throw new Error("Pass the initial password through hidden input piped to stdin.");
  const data = readFileSync(0, "utf8").replace(/\r?\n$/, "");
  const passwordHash = await hashPassword(passwordSchema.parse(data));
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(57241010)`);
    const [existing] = await tx.select({ id: users.id }).from(users).where(eq(users.superAdmin, true)).limit(1);
    if (existing) throw new Error("A Super Admin already exists.");
    const [admin] = await tx.insert(users).values({ username, displayName, passwordHash, superAdmin: true }).returning();
    for (const name of starterCompanies) {
      const [company] = await tx.select({ id: companies.id }).from(companies).where(sql`lower(${companies.name}) = lower(${name})`);
      if (!company) await insertCompany(tx, name);
    }
    await tx.insert(auditLogs).values({ actorId: admin.id, action: "admin.bootstrap" });
  });
  console.log("Super Admin and starter companies initialized. The initial password must be changed at first sign-in.");
}

bootstrap().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Bootstrap failed");
  process.exitCode = 1;
});
