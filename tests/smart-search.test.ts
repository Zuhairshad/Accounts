import { describe, expect, it } from "vitest";
import { rankSearch, searchScore } from "../src/lib/smart-search";

const labels = [
  "1001 · Cash In Hand(Azam Ent)", "1003 · Rauf Mann Sb Acct", "1100 · Accounts Receivable", "1200 · Inventory",
  "2000 · Accounts Payable", "3900 · Opening Balance Equity", "6206 · Svcs Charges", "6303 · Veh Rep & Maint Exp",
  "6309 · Printing Exp", "7001 · Sakoon / Khawab  Exp", "Greaves Pakistan (Pvt) Ltd · supplier", "Kun Traders · supplier",
];
const top = (query: string) => rankSearch(query, labels, (label) => label)[0];

describe("smart search", () => {
  it("finds labels by partial words in any order", () => {
    expect(top("cash")).toBe("1001 · Cash In Hand(Azam Ent)");
    expect(top("acct rauf")).toBe("1003 · Rauf Mann Sb Acct");
    expect(top("pay")).toBe("2000 · Accounts Payable");
  });

  it("finds account codes, initials, abbreviations and names typed without spaces", () => {
    expect(top("6309")).toBe("6309 · Printing Exp");
    expect(top("63")).toBe("6303 · Veh Rep & Maint Exp");
    expect(rankSearch("6309", [...labels, "6300 · Office Expense", "6209 · Bank Charges"], (label) => label)).toEqual(["6309 · Printing Exp"]);
    expect(rankSearch("cash", ["Cash Purchase · supplier", "1000 · Cash", "1001 · Cash In Hand(Azam Ent)"], (label) => label)[0]).toBe("1000 · Cash");
    expect(top("ar")).toBe("1100 · Accounts Receivable");
    expect(top("obe")).toBe("3900 · Opening Balance Equity");
    expect(top("rcvbl")).toBe("1100 · Accounts Receivable");
    expect(top("cashinhand")).toBe("1001 · Cash In Hand(Azam Ent)");
    expect(top("sakoon khawab")).toBe("7001 · Sakoon / Khawab  Exp");
    expect(top("rep and maint")).toBe("6303 · Veh Rep & Maint Exp");
  });

  it("tolerates typos", () => {
    expect(top("recievable")).toBe("1100 · Accounts Receivable");
    expect(top("invantory")).toBe("1200 · Inventory");
    expect(top("greves")).toBe("Greaves Pakistan (Pvt) Ltd · supplier");
    expect(top("printng")).toBe("6309 · Printing Exp");
    expect(rankSearch("salry", ["4000 · Sales Revenue", "6001 · Advance Salaries", "2150 · Sales Tax Payable", "6000 · Salaries Expense"], (label) => label))
      .toEqual(["6001 · Advance Salaries", "6000 · Salaries Expense"]);
  });

  it("ranks closer matches first and rejects unrelated text", () => {
    expect(top("ap")).toBe("2000 · Accounts Payable");
    expect(top("inv")).toBe("1200 · Inventory");
    expect(rankSearch("exp", labels, (label) => label).slice(0, 3)).toEqual(["6303 · Veh Rep & Maint Exp", "6309 · Printing Exp", "7001 · Sakoon / Khawab  Exp"]);
    expect(searchScore("zzz", "1200 · Inventory")).toBeNull();
    expect(searchScore("cash bank", "1001 · Cash In Hand(Azam Ent)")).toBeNull();
    expect(rankSearch("", labels, (label) => label)).toEqual(labels);
  });
});
