import { describe, expect, it } from "vitest";
import { verifyBalanced } from "../src/lib/accounting";
import { formatMoney } from "../src/lib/display";
import { hashPassword, verifyPassword } from "../src/lib/password";
import { resolveRange } from "../src/lib/range";
import { financialYearSchema, usernameSchema } from "../src/lib/validation";

describe("accounting primitives", () => {
  it("accepts decimal amounts without float error", () => {
    expect(() => verifyBalanced([{ debit: "0.10", credit: "0" }, { debit: "0.20", credit: "0" }, { debit: "0", credit: "0.30" }])).not.toThrow();
    expect(() => verifyBalanced([{ debit: "999999999999999999.99", credit: "0" }, { debit: "0", credit: "999999999999999999.98" }])).toThrow("must match");
  });

  it("rejects excess precision, two-sided lines and non-finite input", () => {
    const credit = { debit: "0", credit: "1.00" };
    for (const debit of ["NaN", "1e0", "-1", "1.001"]) {
      expect(() => verifyBalanced([{ debit, credit: "0" }, credit])).toThrow("Invalid ledger amount");
    }
    expect(() => verifyBalanced([{ debit: "3", credit: "2" }, credit])).toThrow("one positive side");
    expect(formatMoney("999999999999999999.98")).toBe("999,999,999,999,999,999.98");
  });
});

describe("access and dates", () => {
  it("normalizes username and keeps password hashes salted", async () => {
    expect(usernameSchema.parse("  Test.User  ")).toBe("test.user");
    const password = "long test password for hashing";
    const [first, second] = await Promise.all([hashPassword(password), hashPassword(password)]);
    expect(first).not.toBe(second);
    expect(await verifyPassword(password, first)).toBe(true);
    expect(await verifyPassword("incorrect", first)).toBe(false);
    expect(await verifyPassword(password, undefined)).toBe(false);
  });

  it("validates calendar and financial-year boundaries", () => {
    const year = { startsOn: "2026-07-01", endsOn: "2027-06-30" };
    expect(financialYearSchema.safeParse({ name: "FY 27", ...year }).success).toBe(true);
    expect(financialYearSchema.safeParse({ name: "Invalid", startsOn: "2026-02-29", endsOn: "2026-06-30" }).success).toBe(false);
    expect(resolveRange({ from: "2026-06-30" }, year).error).toMatch(/valid date range/);
    expect(resolveRange({ from: "2026-08-01", to: "2026-08-31" }, year).error).toBeNull();
  });
});
