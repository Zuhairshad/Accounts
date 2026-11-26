import Decimal from "decimal.js";
import { and, eq, sql } from "drizzle-orm";
import type { Transaction } from "../db";
import { documentSequences, idempotencyRequests } from "../db/schema";

const Exact = Decimal.clone({ precision: 64 });
const amountPattern = /^(?:0|[1-9]\d{0,17})(?:\.\d{1,2})?$/;

export function verifyBalanced(lines: { debit: string; credit: string }[]) {
  if (lines.length < 2) throw new Error("A posted voucher needs at least two lines.");
  let total = new Exact(0);
  for (const line of lines) {
    if (!amountPattern.test(line.debit) || !amountPattern.test(line.credit)) throw new Error("Invalid ledger amount.");
    const debit = new Exact(line.debit);
    const credit = new Exact(line.credit);
    if (debit.isZero() === credit.isZero()) throw new Error("Each line needs one positive side.");
    total = total.plus(debit).minus(credit);
  }
  if (!total.isZero()) throw new Error("Debit and credit totals must match.");
}

export async function nextSequence(tx: Transaction, companyId: string, yearId: string, kind: string) {
  const [sequence] = await tx.insert(documentSequences).values({ companyId, yearId, kind, lastValue: 1 })
    .onConflictDoUpdate({
      target: [documentSequences.companyId, documentSequences.yearId, documentSequences.kind],
      set: { lastValue: sql`${documentSequences.lastValue} + 1` },
    }).returning({ value: documentSequences.lastValue });
  return sequence.value;
}

export async function idempotently<T extends Record<string, unknown>>(
  tx: Transaction,
  input: { companyId: string; operation: string; key: string; actorId: string; requestHash: string },
  apply: () => Promise<T>,
): Promise<T> {
  const match = and(eq(idempotencyRequests.companyId, input.companyId),
    eq(idempotencyRequests.operation, input.operation), eq(idempotencyRequests.key, input.key));
  const [inserted] = await tx.insert(idempotencyRequests).values(input).onConflictDoNothing().returning();
  if (!inserted) {
    const [existing] = await tx.select().from(idempotencyRequests).where(match);
    if (!existing || existing.actorId !== input.actorId || existing.requestHash !== input.requestHash || !existing.result) {
      throw new Error("This request key cannot be reused for different work.");
    }
    return existing.result as T;
  }
  const result = await apply();
  await tx.update(idempotencyRequests).set({ result }).where(match);
  return result;
}
