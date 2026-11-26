import ExcelJS from "exceljs";
import { sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../src/db";
import { csvReport, workbookReport } from "../src/lib/reports/export";
import { moneyCell, textCell, type ReportDocument } from "../src/lib/reports/model";
import { companyFixture, connect, day, testUrl } from "./support/fixture";

const hostile = ["=HYPERLINK(\"http://evil\",\"x\")", "+cmd|' /C calc'!A0", "-2+3", "@SUM(1)", "\tTAB", "﻿=1+1"];
const doc = (): ReportDocument => ({
  id: "voucher-register", title: "Voucher Register", scope: ["Test"], companyDetails: [], from: day(1), to: day(31), generatedAt: "",
  columns: ["Narration", "Amount"], notes: [], rows: hostile.map((value, i) => ({ key: String(i), cells: [textCell(value), moneyCell("-12.50")] })),
});
const read = async (stream: ReadableStream<Uint8Array>) => Buffer.from(await new Response(stream).arrayBuffer());

describe("spreadsheet export safety", () => {
  it("neutralises formula-like text in CSV while keeping negative amounts numeric", async () => {
    const lines = (await read(csvReport(doc()))).toString("utf8").replace(/^﻿/, "").trim().split("\r\n").slice(1);
    for (const line of lines) {
      const [, text, amount] = /^"(.*)","(.*)"$/s.exec(line)!;
      expect(text.startsWith("'")).toBe(true);
      expect(amount).toBe("-12.50");
    }
  });
  it("writes hostile text as literal strings, never formulas, in Excel", async () => {
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(await new Response(workbookReport(doc())).arrayBuffer());
    const sheet = book.worksheets[0];
    const cells: ExcelJS.Cell[] = [];
    sheet.eachRow((row) => row.eachCell((cell) => cells.push(cell)));
    expect(cells.some((c) => c.type === ExcelJS.ValueType.Formula)).toBe(false);
    expect(cells.filter((c) => typeof c.value === "string" && hostile.includes(c.value as string))).toHaveLength(hostile.length);
    expect(cells.filter((c) => c.value === -12.5)).toHaveLength(hostile.length);
  });
});

describe.skipIf(!testUrl)("audit trail integrity", () => {
  let pool: Pool;
  let db: Database;
  beforeAll(() => { ({ pool, db } = connect()); });
  afterAll(async () => { await pool?.end(); });
  it("refuses updates and deletes of audit and history rows even for the database owner", async () => {
    const f = await companyFixture(db, "Audit");
    await f.saveVoucher(f.voucher("JV", day(2), [f.line("cash", "debit", "10"), f.line("4100", "credit", "10")]));
    for (const statement of [
      sql`UPDATE audit_logs SET action='tampered' WHERE company_id=${f.companyId}`,
      sql`DELETE FROM audit_logs WHERE company_id=${f.companyId}`,
      sql`DELETE FROM transaction_revisions WHERE company_id=${f.companyId}`,
      sql`UPDATE voucher_timeline SET number='X' WHERE company_id=${f.companyId}`,
      sql`TRUNCATE audit_logs`,
    ]) await expect(db.execute(statement)).rejects.toThrow();
    const [count] = (await db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM audit_logs WHERE company_id=${f.companyId}`)).rows;
    expect(Number(count.n)).toBeGreaterThan(0);
  });
});
