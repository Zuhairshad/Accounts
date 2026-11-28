import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database, Transaction } from "../src/db";
import * as schema from "../src/db/schema";
import { insertCompany } from "../src/db/seed";
import { idempotently } from "../src/lib/accounting";
import { saveOpening } from "../src/lib/engine/masters";
import { AccountingError, Exact, manualTypes, manualVoucher, type VoucherInput } from "../src/lib/engine/model";
import { openingRows, readLedger, readVoucher } from "../src/lib/engine/read";
import { allocatePayment, invoiceOutstanding, paymentSources, releaseAllocation } from "../src/lib/engine/settlement";
import { openPeriod } from "../src/lib/engine/posting";
import { changeVoucher, postOriginVoucher, repairLegacyParty, saveManual, type FinanceContext } from "../src/lib/engine/vouchers";

const url = process.env.AZAM_TEST_DATABASE_URL;
const debitDate = "2026-01-12";
const paymentDate = "2026-02-12";
const end = "2026-12-31";

describe.skipIf(!url)("phase two accounting engine", () => {
  let pool: Pool;
  let db: Database;
  let companyId: string;
  let otherCompanyId: string;
  let otherAccountId: string;
  let actorId: string;
  let approverId: string;
  let customerId: string;
  let supplierId: string;
  let context: FinanceContext;
  let heads: Record<string, string>;

  beforeAll(async () => {
    if (!url || !new URL(url).pathname.endsWith("_test")) throw new Error("Use a disposable _test PostgreSQL database.");
    pool = new Pool({ connectionString: url });
    db = drizzle(pool, { schema });
    await db.transaction(async (tx) => {
      const token = randomUUID();
      companyId = (await insertCompany(tx, `Phase2 engine ${token}`)).id;
      otherCompanyId = (await insertCompany(tx, `Phase2 other ${token}`)).id;
      const users = await tx.insert(schema.users).values([
        { username: `phase2-${token}`, displayName: "Ledger clerk", passwordHash: "test-fixture-only" },
        { username: `approver-${token}`, displayName: "Ledger approver", passwordHash: "test-fixture-only" },
      ]).returning();
      actorId = users[0].id;
      approverId = users[1].id;
      context = { companyId, actorId, require: () => undefined };
      const [year] = await tx.insert(schema.financialYears).values({ companyId, name: "2026", startsOn: "2026-01-01", endsOn: end }).returning();
      await tx.insert(schema.periods).values([
        { companyId, yearId: year.id, startsOn: "2026-01-01", endsOn: "2026-01-31" },
        { companyId, yearId: year.id, startsOn: "2026-02-01", endsOn: end },
      ]);
      heads = Object.fromEntries((await tx.select().from(schema.accounts).where(eq(schema.accounts.companyId, companyId))).map((head) => [head.control ?? head.code, head.id]));
      otherAccountId = (await tx.select().from(schema.accounts).where(and(eq(schema.accounts.companyId, otherCompanyId), eq(schema.accounts.control, "cash"))))[0].id;
      const parties = await tx.insert(schema.parties).values([
        { companyId, name: "Example customer", type: "customer" },
        { companyId, name: "Example supplier", type: "supplier" },
      ]).returning();
      customerId = parties[0].id;
      supplierId = parties[1].id;
    });
  });

  afterAll(async () => { await pool?.end(); });

  function locked<T>(run: (tx: Transaction) => Promise<T>) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`select id from companies where id=${companyId} for update`);
      return run(tx);
    });
  }

  function line(account: string, side: "debit" | "credit", amount: string, partyId: string | null = null) {
    return { accountId: heads[account] ?? account, partyId, description: "", debit: side === "debit" ? amount : "0", credit: side === "credit" ? amount : "0" };
  }

  function entry(type: VoucherInput["type"], lines: VoucherInput["lines"], mode: VoucherInput["mode"] = "direct", date = paymentDate): VoucherInput {
    return { type, lines, mode, date, reference: "ACCT-REF", narration: "Posted for accounting verification" };
  }

  const save = (tx: Transaction, entry: VoucherInput, intent: "draft" | "post" | "submit" = "post", id?: string, version = 0) =>
    saveManual(tx, context, { entry, intent, id, version, reason: id ? "Verified correction" : "" });

  function ledger(partyId: string) {
    return readLedger(db, companyId, { partyId }, paymentDate, end);
  }

  it("posts customer 10,000 Dr and supplier 20,000 Cr openings and applies their receipts/payments, with void and restore", async () => {
    await locked(async (tx) => {
      await saveOpening(tx, context, { kind: "party", targetId: customerId, direction: "debit", amount: "10000", date: debitDate, version: 0, reason: "Original customer opening" });
      await saveOpening(tx, context, { kind: "party", targetId: supplierId, direction: "credit", amount: "20000", date: debitDate, version: 0, reason: "Original supplier opening" });
    });
    const receipt = await locked((tx) => save(tx, entry("CRV", [line("cash", "debit", "4000"), line("receivable", "credit", "4000", customerId)], "party")));
    const payment = await locked((tx) => save(tx, entry("BPV", [line("payable", "debit", "5000", supplierId), line("bank", "credit", "5000")], "party")));
    expect(await ledger(customerId)).toMatchObject({ opening: "10000.00", closing: "6000.00", rows: [{ running: "6000.00" }] });
    expect(await ledger(supplierId)).toMatchObject({ opening: "-20000.00", closing: "-15000.00", rows: [{ running: "-15000.00" }] });
    for (const [doc, partyId, reverted, restored] of [
      [receipt, customerId, "10000.00", "6000.00"], [payment, supplierId, "-20000.00", "-15000.00"],
    ] as const) {
      const prior = (await readVoucher(db, companyId, doc.id))!;
      await locked((tx) => changeVoucher(tx, context, { id: doc.id, version: prior.version, operation: "delete", reason: "Verify reversible deletion" }));
      expect((await ledger(partyId)).closing).toBe(reverted);
      await expect(locked((tx) => changeVoucher(tx, context, { id: doc.id, version: prior.version, operation: "delete", reason: "Duplicate deletion" }))).rejects.toThrow(/changed/);
      await locked((tx) => changeVoucher(tx, context, { id: doc.id, version: prior.version + 1, operation: "restore", reason: "Restore original voucher" }));
      expect((await ledger(partyId)).closing).toBe(restored);
      expect((await readVoucher(db, companyId, doc.id))?.number).toBe(prior.number);
      await expect(locked((tx) => changeVoucher(tx, context, { id: doc.id, version: prior.version + 2, operation: "restore", reason: "Repeat restore" }))).rejects.toThrow(/already been restored/);
      expect((await ledger(partyId)).rows).toHaveLength(1);
    }
  });

  it("posts all six voucher types, including multi-line and direct-account receipts and payments", async () => {
    const cases = [
      entry("JV", [line("cash", "debit", "0.10"), line("bank", "debit", "0.20"), line("sales", "credit", "0.30")]),
      entry("VR", [line("cash", "debit", "15"), line("4100", "credit", "15")]),
      entry("CPV", [line("6000", "debit", "25"), line("cash", "credit", "25")]),
      entry("CRV", [line("cash", "debit", "35"), line("4100", "credit", "35")]),
      entry("BPV", [line("6100", "debit", "45"), line("bank", "credit", "45")]),
      entry("BRV", [line("bank", "debit", "55"), line("receivable", "credit", "55", customerId)], "party"),
    ];
    expect(cases.map((test) => test.type)).toEqual([...manualTypes]);
    for (const test of cases) {
      const posted = await locked((tx) => save(tx, test));
      expect(posted.number).toMatch(new RegExp(`^${test.type}-20260212-`));
      expect((await readVoucher(db, companyId, posted.id))?.postedLines).toHaveLength(test.lines.length);
    }
    await expect(locked((tx) => save(tx, entry("CPV", [line("payable", "debit", "4", supplierId), line("bank", "credit", "4")], "party")))).rejects.toThrow(/cash accounts/);
    await expect(locked((tx) => save(tx, entry("CRV", [line("cash", "debit", "4"), line("4100", "credit", "4")], "party")))).rejects.toThrow(/require customers/);
  });

  it("keeps a shared opening document, validates stale changes and supports an opposite-direction advance", async () => {
    const initial = (await openingRows(db, companyId)).find((row) => row.targetId === customerId)!;
    await expect(locked((tx) => saveOpening(tx, context, {
      kind: "party", targetId: customerId, direction: "credit", amount: "1000", date: debitDate, version: 0, reason: "Reject stale individual opening",
    }))).rejects.toThrow(/changed/);
    await locked((tx) => saveOpening(tx, context, {
      kind: "party", targetId: customerId, direction: "credit", amount: "1000", date: debitDate, version: initial.version, reason: "Confirmed customer advance opening",
    }));
    const all = (await openingRows(db, companyId)).filter((row) => row.targetId === customerId);
    expect(all).toMatchObject([{ id: initial.id, direction: "credit", amount: "1000.00" }]);
    expect((await ledger(customerId)).opening).toBe("-1000.00");
    await locked((tx) => saveOpening(tx, context, {
      kind: "party", targetId: customerId, direction: "credit", amount: "0", date: debitDate, version: all[0].version, reason: "Void historical opening amount",
    }));
    expect((await ledger(customerId)).opening).toBe("0");
    const voided = (await readVoucher(db, companyId, initial.id))!;
    await locked((tx) => changeVoucher(tx, context, { id: initial.id, version: voided.version, operation: "restore", reason: "Restore opening advance" }));
    expect((await ledger(customerId)).opening).toBe("-1000.00");
  });

  it("keeps drafts out of the ledger and replaces a revision without changing the original number", async () => {
    const initial = entry("JV", [line("cash", "debit", "15"), line("sales", "credit", "15")]);
    const draft = await locked((tx) => save(tx, initial, "draft"));
    expect((await readVoucher(db, companyId, draft.id))?.postedLines).toHaveLength(0);
    const posted = await locked((tx) => save(tx, initial, "post", draft.id, 1));
    const before = (await readVoucher(db, companyId, draft.id))!;
    const revised = { ...initial, lines: [line("cash", "debit", "17"), line("sales", "credit", "17")] };
    const changes = await Promise.allSettled([
      locked((tx) => save(tx, revised, "post", draft.id, before.version)),
      locked((tx) => save(tx, revised, "post", draft.id, before.version)),
    ]);
    expect(changes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const after = (await readVoucher(db, companyId, draft.id))!;
    expect(after.number).toBe(posted.number);
    expect(after.postedLines[0].debit).toBe("17.00");
    const journal = await readLedger(db, companyId, { accountId: heads.cash }, "2026-01-01", end);
    expect(journal.rows.filter((row) => row.documentId === draft.id)).toMatchObject([{ debit: "17.00" }]);
    const history = await db.select().from(schema.revisions).where(eq(schema.revisions.entityId, draft.id));
    expect(history).toHaveLength(3);
    expect(history[2].previousData).toBeDefined();
    expect(history[2].nextData).toBeDefined();
  });

  it("handles duplicate requests and concurrent voucher numbers", async () => {
    const voucher = entry("VR", [line("cash", "debit", "5"), line("sales", "credit", "5")]);
    const data = { companyId, operation: "phase2.test.save", key: randomUUID(), actorId, requestHash: "identical" };
    const results = await Promise.all(Array.from({ length: 4 }, () => locked((tx) => idempotently(tx, data, () => save(tx, voucher)))));
    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    const distinct = await Promise.all(Array.from({ length: 4 }, () => locked((tx) => save(tx, voucher))));
    expect(new Set(distinct.map((result) => result.number)).size).toBe(4);
  });

  it("rejects invalid dates, cross-company accounts and party-control mismatches, and blocks closed-period changes", async () => {
    expect(manualVoucher.safeParse(entry("JV", [], "direct", "2026-02-29")).success).toBe(false);
    await expect(locked((tx) => save(tx, entry("JV", [line(otherAccountId, "debit", "4"), line("sales", "credit", "4")])))).rejects.toThrow(/active account in this company/);
    await expect(locked((tx) => save(tx, entry("JV", [line("cash", "debit", "4"), line("payable", "credit", "4", customerId)])))).rejects.toThrow(/matching AR or AP/);
    await expect(locked((tx) => save(tx, entry("JV", [line("cash", "debit", "4"), line("sales", "credit", "3")])))).rejects.toThrow(/must match/);
    const voucher = await locked((tx) => save(tx, entry("JV", [line("cash", "debit", "4"), line("sales", "credit", "4")], "direct", debitDate)));
    const period = await locked((tx) => openPeriod(tx, companyId, debitDate));
    await db.update(schema.periods).set({ closed: true }).where(eq(schema.periods.id, period.id));
    try {
      const original = (await readVoucher(db, companyId, voucher.id))!;
      await expect(locked((tx) => changeVoucher(tx, context, { id: voucher.id, version: original.version, operation: "delete", reason: "Closed-period deletion" }))).rejects.toThrow(/closed/);
      await expect(locked((tx) => save(tx, entry("JV", [line("cash", "debit", "5"), line("sales", "credit", "5")]), "post", voucher.id, original.version))).rejects.toThrow(/closed/);
      await expect(locked((tx) => save(tx, entry("JV", [line("cash", "debit", "5"), line("sales", "credit", "5")], "direct", debitDate)))).rejects.toThrow(/closed/);
    } finally {
      await db.update(schema.periods).set({ closed: false }).where(eq(schema.periods.id, period.id));
    }
  });

  it("enforces post permission and requires a different authorized approver for a submitted draft", async () => {
    const voucher = entry("JV", [line("cash", "debit", "42"), line("sales", "credit", "42")]);
    const dataEntry: FinanceContext = { ...context, require: (permission) => {
      if (permission !== "create" && permission !== "edit") throw new AccountingError("Insufficient permissions");
    } };
    await expect(locked((tx) => saveManual(tx, dataEntry, { entry: voucher, intent: "post", version: 0, reason: "" }))).rejects.toThrow(/Insufficient permissions/);
    await db.update(schema.companySettings).set({ voucherApproval: true }).where(eq(schema.companySettings.companyId, companyId));
    try {
      await expect(locked((tx) => save(tx, voucher))).rejects.toThrow(/approval/);
      const draft = await locked((tx) => saveManual(tx, dataEntry, { entry: voucher, intent: "submit", version: 0, reason: "" }));
      const posting = { id: draft.id, version: 1, operation: "post" as const, reason: "Checked by another user" };
      await expect(locked((tx) => changeVoucher(tx, context, posting))).rejects.toThrow(/different authorized user/);
      await locked((tx) => changeVoucher(tx, { ...context, actorId: approverId }, posting));
      expect((await readVoucher(db, companyId, draft.id))?.status).toBe("posted");
    } finally {
      await db.update(schema.companySettings).set({ voucherApproval: false }).where(eq(schema.companySettings.companyId, companyId));
    }
  });

  it("links explicitly selected untagged legacy parties without changing journal values or duplicating the posting", async () => {
    const id = randomUUID();
    await locked(async (tx) => {
      const period = await openPeriod(tx, companyId, paymentDate);
      await tx.insert(schema.vouchers).values({ id, companyId, periodId: period.id, date: paymentDate, type: "JV", createdBy: actorId });
      await tx.insert(schema.journalLines).values([
        { ...line("receivable", "debit", "100"), companyId, voucherId: id, lineNo: 4 },
        { ...line("sales", "credit", "100"), companyId, voucherId: id, lineNo: 7 },
      ]);
      await tx.update(schema.vouchers).set({ status: "posted", number: "LEGACY-REPAIR", postedAt: new Date() }).where(eq(schema.vouchers.id, id));
    });
    const prior = new Exact((await ledger(customerId)).closing);
    await locked((tx) => repairLegacyParty(tx, context, { voucherId: id, reason: "Paper ledger receipt confirmed", links: [{ lineNumber: 4, partyId: customerId }] }));
    expect((await readVoucher(db, companyId, id))?.number).toBe("LEGACY-REPAIR");
    expect((await ledger(customerId)).closing).toBe(prior.plus(100).toFixed(2));
    await expect(locked((tx) => repairLegacyParty(tx, context, { voucherId: id, reason: "Repeat should fail", links: [{ lineNumber: 4, partyId: customerId }] }))).rejects.toThrow(/already belongs/);
  });

  it("revises and deletes imported legacy vouchers with an append-only posting timeline", async () => {
    const legacy = async (number: string) => {
      const id = randomUUID();
      await locked(async (tx) => {
        const period = await openPeriod(tx, companyId, paymentDate);
        await tx.insert(schema.vouchers).values({ id, companyId, periodId: period.id, date: paymentDate, type: "JV", createdBy: actorId });
        await tx.insert(schema.journalLines).values([
          { ...line("cash", "debit", "15000"), companyId, voucherId: id, lineNo: 1 },
          { ...line("opening_equity", "credit", "15000"), companyId, voucherId: id, lineNo: 2 },
        ]);
        await tx.update(schema.vouchers).set({ status: "posted", number, postedAt: new Date() }).where(eq(schema.vouchers.id, id));
      });
      return id;
    };
    const revisedId = await legacy(`LEGACY-REVISE-${randomUUID()}`);
    await locked((tx) => saveManual(tx, context, {
      entry: entry("JV", [line("cash", "debit", "98085"), line("opening_equity", "credit", "98085")]),
      id: revisedId, version: 0, intent: "post", reason: "Corrected in the desktop application",
    }));
    const revised = (await readVoucher(db, companyId, revisedId))!;
    expect(revised.status).toBe("posted");
    expect(revised.postedLines.map((row) => row.debit)).toContain("98085.00");
    const versions = await db.select().from(schema.voucherTimeline).where(eq(schema.voucherTimeline.documentId, revisedId));
    expect(versions.map((row) => row.status)).toEqual(expect.arrayContaining(["draft", "posted"]));

    const deletedId = await legacy(`LEGACY-DELETE-${randomUUID()}`);
    await locked((tx) => changeVoucher(tx, context, { id: deletedId, version: 0, operation: "delete", reason: "Entered twice" }));
    expect((await readVoucher(db, companyId, deletedId))?.status).toBe("void");
  });

  it("rejects a generated voucher when its originating invoice or adjustment is missing", async () => {
    const missingId = randomUUID();
    await expect(locked((tx) => postOriginVoucher(tx, context, { kind: "invoice", id: missingId }, {
      type: "sale", date: paymentDate, narration: "Missing source", reference: "",
      lines: [line("receivable", "debit", "15", customerId), line("sales", "credit", "15")],
    }))).rejects.toMatchObject({ cause: { code: "23514" } });
    const rows = await db.select().from(schema.voucherDocuments).where(eq(schema.voucherDocuments.sourceId, missingId));
    expect(rows).toHaveLength(0);
  });

  it("retains a supplier overpayment as a debit advance", async () => {
    const before = new Exact((await ledger(supplierId)).closing);
    const payment = await locked((tx) => save(tx, entry("CPV", [
      line("payable", "debit", "25000", supplierId), line("cash", "credit", "25000"),
    ], "party")));
    const after = new Exact((await ledger(supplierId)).closing);
    expect(after.toFixed(2)).toBe(before.plus("25000").toFixed(2));
    expect(after.gt(0)).toBe(true);
    const debit = (await paymentSources(db, companyId, supplierId, end)).find((row) => row.documentId === payment.id);
    expect(debit?.unallocated).toBe("25000.00");
  });

  it("allocates explicitly and FIFO, handles linked credit notes and overpayments, and releases allocations", async () => {
    const postTrade = (type: "sale" | "sale_return", amount: string, date: string, originalInvoiceId?: string) => locked(async (tx) => {
      const id = randomUUID();
      const isSale = type === "sale";
      const voucher = await postOriginVoucher(tx, context, { kind: "invoice", id }, {
        type, date, reference: "", narration: type, lines: [
          line("receivable", isSale ? "debit" : "credit", amount, customerId),
          line(isSale ? "sales" : "sales_returns", isSale ? "credit" : "debit", amount),
        ],
      });
      await tx.insert(schema.invoices).values({
        id, companyId, partyId: customerId, number: `INV-${id}`, type, date, dueOn: "2026-01-30", total: amount,
        voucherId: voucher.voucherId, originalInvoiceId, status: "posted",
      });
      return { id, journalId: voucher.document.id };
    });
    const first = await postTrade("sale", "150", debitDate);
    const second = await postTrade("sale", "100", "2026-01-13");
    await postTrade("sale_return", "25", "2026-01-14", first.id);
    const receipt = await locked((tx) => save(tx, entry("BRV", [line("bank", "debit", "300"), line("receivable", "credit", "300", customerId)], "party")));
    const payment = (await paymentSources(db, companyId, customerId, end)).find((row) => row.documentId === receipt.id)!;
    await locked((tx) => allocatePayment(tx, context, { partyId: customerId, lineId: payment.id, invoiceId: first.id, date: paymentDate, amount: "50" }));
    const result = await locked((tx) => allocatePayment(tx, context, { partyId: customerId, lineId: payment.id, date: paymentDate, amount: "250" }));
    expect(result.remaining).toBe("75.00");
    const aging = await invoiceOutstanding(db, companyId, end, customerId);
    expect(aging.find((row) => row.id === first.id)).toMatchObject({ creditNotes: "25.00", allocated: "125.00", outstanding: "0.00" });
    expect(aging.find((row) => row.id === second.id)).toMatchObject({ allocated: "100.00", outstanding: "0.00" });
    expect((await paymentSources(db, companyId, customerId, end)).find((row) => row.id === payment.id)?.unallocated).toBe("75.00");
    const voucher = (await readVoucher(db, companyId, receipt.id))!;
    await expect(locked((tx) => changeVoucher(tx, context, { id: receipt.id, version: voucher.version, operation: "delete", reason: "Guard allocated payment" }))).rejects.toThrow(/Release/);
    await expect(locked((tx) => changeVoucher(tx, context, { id: first.journalId, version: 2, operation: "delete", reason: "Wrong origin workflow" }))).rejects.toThrow(/originating/);
    const [allocation] = await db.select().from(schema.allocations).where(and(eq(schema.allocations.paymentLineId, payment.id), eq(schema.allocations.invoiceId, second.id)));
    await locked((tx) => releaseAllocation(tx, context, { id: allocation.id, partyId: customerId, date: "2026-02-14", reason: "Customer changed allocation instructions" }));
    expect((await invoiceOutstanding(db, companyId, "2026-02-13", customerId)).find((row) => row.id === second.id)?.outstanding).toBe("0.00");
    expect((await invoiceOutstanding(db, companyId, end, customerId)).find((row) => row.id === second.id)?.outstanding).toBe("100.00");
  });
});
