import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../src/db/schema";
import { insertCompany } from "../src/db/seed";
import { idempotently, nextSequence } from "../src/lib/accounting";

const url = process.env.AZAM_TEST_DATABASE_URL;

describe.skipIf(!url)("isolated PostgreSQL integrity", () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let actorId: string;
  let companyId: string;
  let otherCompanyId: string;
  let periodId: string;
  let yearId: string;
  let accountId: string;
  let secondAccountId: string;
  let otherAccountId: string;

  beforeAll(async () => {
    if (!url || !new URL(url).pathname.endsWith("_test")) throw new Error("An isolated database with a name ending in _test is required.");
    pool = new Pool({ connectionString: url });
    db = drizzle(pool, { schema });
    await db.transaction(async (tx) => {
      const token = randomUUID();
      const [actor] = await tx.insert(schema.users).values({ username: `test-${token}`, displayName: "Integration test", passwordHash: "test-only" }).returning();
      actorId = actor.id;
      companyId = (await insertCompany(tx, `Integration company ${token}`)).id;
      otherCompanyId = (await insertCompany(tx, `Integration other ${token}`)).id;
      const [year] = await tx.insert(schema.financialYears).values({ companyId, name: "Test year", startsOn: "2026-01-01", endsOn: "2026-12-31" }).returning();
      yearId = year.id;
      const [period] = await tx.insert(schema.periods).values({ companyId, yearId, startsOn: "2026-01-01", endsOn: "2026-01-31" }).returning();
      periodId = period.id;
      const chart = await tx.select().from(schema.accounts).where(eq(schema.accounts.companyId, companyId)).orderBy(schema.accounts.code);
      accountId = chart[0].id;
      secondAccountId = chart[1].id;
      const [other] = await tx.select().from(schema.accounts).where(eq(schema.accounts.companyId, otherCompanyId)).limit(1);
      otherAccountId = other.id;
    });
  });

  afterAll(async () => { await pool?.end(); });

  it("allocates distinct sequence numbers on concurrent transactions", async () => {
    const values = await Promise.all(Array.from({ length: 8 }, () => db.transaction((tx) => nextSequence(tx, companyId, yearId, "JV"))));
    expect(values.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("deduplicates simultaneous retries and rejects another payload", async () => {
    const input = { companyId, operation: "integration.test", key: randomUUID(), actorId, requestHash: "request-one" };
    let applies = 0;
    const write = () => db.transaction((tx) => idempotently(tx, input, async () => {
      applies += 1;
      return { document: "saved" };
    }));
    expect(await Promise.all([write(), write()])).toEqual([{ document: "saved" }, { document: "saved" }]);
    expect(applies).toBe(1);
    await expect(db.transaction((tx) => idempotently(tx, { ...input, requestHash: "request-two" }, async () => ({})))).rejects.toThrow(/cannot be reused/);
  });

  it("rejects cross-company account links", async () => {
    await expect(db.transaction(async (tx) => {
      const [voucher] = await tx.insert(schema.vouchers).values({ companyId, periodId, date: "2026-01-15", type: "JV", createdBy: actorId }).returning();
      await tx.insert(schema.journalLines).values({ companyId, voucherId: voucher.id, lineNo: 1, accountId: otherAccountId, debit: "10" });
    })).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  it("rolls back the complete transaction when posting is unbalanced", async () => {
    const id = randomUUID();
    await expect(db.transaction(async (tx) => {
      await tx.insert(schema.vouchers).values({ id, companyId, periodId, date: "2026-01-15", type: "JV", createdBy: actorId });
      await tx.insert(schema.journalLines).values({ companyId, voucherId: id, lineNo: 1, accountId, debit: "10" });
      await tx.update(schema.vouchers).set({ status: "posted", number: "TEST-UNBALANCED", postedAt: new Date() }).where(eq(schema.vouchers.id, id));
    })).rejects.toMatchObject({ cause: { code: "23514" } });
    expect(await db.select().from(schema.vouchers).where(eq(schema.vouchers.id, id))).toHaveLength(0);
  });

  it("commits balanced entries and guards immutable ledger lines", async () => {
    const id = randomUUID();
    await db.transaction(async (tx) => {
      await tx.insert(schema.vouchers).values({ id, companyId, periodId, date: "2026-01-15", type: "JV", createdBy: actorId });
      await tx.insert(schema.journalLines).values([
        { companyId, voucherId: id, lineNo: 1, accountId, debit: "10" },
        { companyId, voucherId: id, lineNo: 2, accountId: secondAccountId, credit: "10" },
      ]);
      await tx.update(schema.vouchers).set({ status: "posted", number: "TEST-BALANCED", postedAt: new Date() }).where(eq(schema.vouchers.id, id));
    });
    await expect(db.delete(schema.journalLines).where(eq(schema.journalLines.voucherId, id))).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(db.delete(schema.companies).where(eq(schema.companies.id, companyId))).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  it("rejects overlapping years and periods outside their year", async () => {
    await expect(db.insert(schema.financialYears).values({ companyId, name: "Overlap", startsOn: "2026-12-01", endsOn: "2027-12-01" })).rejects.toMatchObject({ cause: { code: "23P01" } });
    await expect(db.insert(schema.periods).values({ companyId, yearId, startsOn: "2026-12-01", endsOn: "2027-12-01" })).rejects.toMatchObject({ cause: { code: "23514" } });
  });
});
