import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { Transaction } from "../../db";
import { accounts, allocations, companySettings, dayBookEntries, financialYears, inventoryAdjustments, invoices, journalLines, parties, periods, voucherDocuments, vouchers, voucherVersions } from "../../db/schema";
import { nextSequence, verifyBalanced } from "../accounting";
import { AccountingError, accountDate, Exact, manualType, type EntryLine, type JournalInput, type VoucherInput } from "./model";

export async function openPeriod(tx: Transaction, companyId: string, date: string) {
  if (!accountDate.safeParse(date).success) throw new AccountingError("Enter a valid accounting date.");
  const [period] = await tx.select({ id: periods.id, yearId: periods.yearId, closed: periods.closed, yearClosed: financialYears.closed })
    .from(periods).innerJoin(financialYears, and(eq(periods.companyId, financialYears.companyId), eq(periods.yearId, financialYears.id)))
    .where(and(eq(periods.companyId, companyId), lte(periods.startsOn, date), gte(periods.endsOn, date))).for("share");
  if (!period) throw new AccountingError("Create an accounting period covering this date before posting.");
  if (period.closed || period.yearClosed) throw new AccountingError("The accounting period is closed.");
  return period;
}

export function balanced(lines: EntryLine[]) {
  try { verifyBalanced(lines); }
  catch (error) { throw new AccountingError(error instanceof Error ? error.message : "Invalid journal lines."); }
}

export async function validateLines(tx: Transaction, companyId: string, lines: EntryLine[]) {
  const ids = [...new Set(lines.map((line) => line.accountId))];
  const partyIds = [...new Set(lines.flatMap((line) => line.partyId ?? []))];
  const accountRows = ids.length ? await tx.select().from(accounts).where(and(eq(accounts.companyId, companyId), inArray(accounts.id, ids))) : [];
  const partyRows = partyIds.length ? await tx.select().from(parties).where(and(eq(parties.companyId, companyId), inArray(parties.id, partyIds))) : [];
  const accountMap = new Map(accountRows.map((account) => [account.id, account]));
  const partyMap = new Map(partyRows.map((party) => [party.id, party]));
  return lines.map((line) => {
    const account = accountMap.get(line.accountId);
    const party = line.partyId ? partyMap.get(line.partyId) : undefined;
    if (!account?.active) throw new AccountingError("Every line must use an active account in this company.");
    if (line.partyId && !party?.active) throw new AccountingError("Every selected party must be active in this company.");
    const isControl = account.control === "receivable" || account.control === "payable";
    if (isControl && !party) throw new AccountingError("Select a customer or supplier for each control account line.");
    if (party && account.control !== (party.type === "customer" ? "receivable" : "payable")) {
      throw new AccountingError("The selected party must use its matching AR or AP control account.");
    }
    return { ...line, account, party };
  });
}

export async function validateManual(tx: Transaction, companyId: string, entry: VoucherInput, posting: boolean) {
  if (entry.lines.some((line) => line.itemId)) throw new AccountingError("Inventory postings must go through the originating document.");
  const lines = await validateLines(tx, companyId, entry.lines);
  if (!posting) return;
  balanced(entry.lines);
  const debit = lines.filter((line) => new Exact(line.debit).gt(0));
  const credit = lines.filter((line) => new Exact(line.credit).gt(0));
  const debitKeys = new Set(debit.map((line) => `${line.accountId}:${line.partyId ?? ""}`));
  if (credit.some((line) => debitKeys.has(`${line.accountId}:${line.partyId ?? ""}`))) {
    throw new AccountingError("The same account and party cannot appear on both sides of a manual voucher.");
  }
  if (entry.type === "JV" || entry.type === "VR") return;

  const receipt = entry.type.endsWith("RV");
  const liquidity = entry.type.startsWith("C") ? "cash" : "bank";
  const settlement = receipt ? debit : credit;
  const counterpart = receipt ? credit : debit;
  if (settlement.some((line) => line.account.liquidity !== liquidity || line.party)) {
    throw new AccountingError(`The ${receipt ? "debit" : "credit"} side must use ${liquidity} accounts.`);
  }
  if (entry.mode === "party" && counterpart.some((line) => line.party?.type !== (receipt ? "customer" : "supplier"))) {
    throw new AccountingError(receipt ? "Party receipts require customers on the credit side." : "Party payments require suppliers on the debit side.");
  }
  if (entry.mode === "direct" && counterpart.some((line) => line.party)) {
    throw new AccountingError("Use party mode when receiving from a customer or paying a supplier.");
  }
}

export async function journalSnapshot(tx: Transaction, companyId: string, voucherId: string) {
  const [header] = await tx.select().from(vouchers).where(and(eq(vouchers.companyId, companyId), eq(vouchers.id, voucherId)));
  if (!header) throw new AccountingError("Voucher version is unavailable.");
  const lines = await tx.select({
    accountId: journalLines.accountId, partyId: journalLines.partyId, itemId: journalLines.itemId, lineNo: journalLines.lineNo,
    debit: journalLines.debit, credit: journalLines.credit, description: journalLines.description,
  }).from(journalLines).where(and(eq(journalLines.companyId, companyId), eq(journalLines.voucherId, voucherId))).orderBy(journalLines.lineNo);
  return { header, lines };
}

export async function ensureUnallocated(tx: Transaction, companyId: string, voucherId: string) {
  const [allocation] = await tx.select({ id: allocations.id }).from(allocations)
    .innerJoin(journalLines, and(eq(journalLines.companyId, allocations.companyId), eq(journalLines.id, allocations.paymentLineId)))
    .where(and(eq(allocations.companyId, companyId), eq(journalLines.voucherId, voucherId), sql`${allocations.endedOn} is null`)).limit(1);
  if (allocation) throw new AccountingError("Release this voucher’s active invoice allocations before changing or voiding it.");
}

export async function protectOrigin(tx: Transaction, companyId: string, voucherId: string) {
  const result = await tx.execute<{ linked: boolean }>(sql`
    select exists(select 1 from ${invoices} where company_id = ${companyId} and voucher_id = ${voucherId})
        or exists(select 1 from ${inventoryAdjustments} where company_id = ${companyId} and voucher_id = ${voucherId}) as linked
  `);
  if (result.rows[0].linked) throw new AccountingError("Manage this journal through its originating document.");
}

export async function postJournal(
  tx: Transaction, context: { companyId: string; actorId: string; documentId: string; originalNumber?: string | null },
  entry: JournalInput,
) {
  const { companyId, actorId, documentId } = context;
  const [document] = await tx.select().from(voucherDocuments).where(and(eq(voucherDocuments.companyId, companyId), eq(voucherDocuments.id, documentId)));
  if (!document || document.type !== entry.type) throw new AccountingError("Journal source does not match the voucher.");
  if (document.source === "manual" && !manualType.safeParse(entry.type).success) throw new AccountingError("Invalid manual voucher type.");
  const origin = document.source === "invoice" || document.source === "inventory_adjustment";
  if (entry.lines.length || !origin) balanced(entry.lines);
  await validateLines(tx, companyId, entry.lines);
  const period = await openPeriod(tx, companyId, entry.date);
  const [settings] = await tx.select().from(companySettings).where(eq(companySettings.companyId, companyId));

  let number = context.originalNumber;
  if (!number) {
    let occupied: boolean;
    do {
      const next = await nextSequence(tx, companyId, period.yearId, entry.type);
      const prefix = settings.numberPrefix ? `${settings.numberPrefix}-` : "";
      number = `${prefix}${entry.type.toUpperCase()}-${entry.date.replaceAll("-", "")}-${String(next).padStart(settings.numberPadding, "0")}`;
      const [existing] = await tx.select({ id: vouchers.id }).from(vouchers)
        .where(and(eq(vouchers.companyId, companyId), eq(vouchers.number, number)));
      occupied = !!existing;
    } while (occupied);
  }
  const [header] = await tx.insert(vouchers).values({
    companyId, periodId: period.id, date: entry.date, type: entry.type, narration: entry.narration, createdBy: actorId,
  }).returning();
  if (entry.lines.length) {
    const postedLines = await tx.insert(journalLines).values(entry.lines.map((line, index) => ({
      ...line, lineNo: index + 1, companyId, voucherId: header.id,
    }))).returning({ id: journalLines.id });
    await tx.insert(dayBookEntries).values(postedLines.map((line) => ({ companyId, journalLineId: line.id })));
  }
  const storageNumber = context.originalNumber ? `revision:${header.id}` : number;
  await tx.update(vouchers).set({ number: storageNumber, status: "posted", postedAt: new Date() })
    .where(and(eq(vouchers.companyId, companyId), eq(vouchers.id, header.id)));
  await tx.insert(voucherVersions).values({ companyId, documentId, voucherId: header.id });
  return { voucherId: header.id, number, yearId: period.yearId };
}
