import { describe, expect, it } from "vitest";
import { lineAllows, manualTypes, voucherSides } from "../src/lib/engine/model";

const cash = { partyId: null, partyType: null, liquidity: "cash" };
const bank = { partyId: null, partyType: null, liquidity: "bank" };
const expense = { partyId: null, partyType: null, liquidity: null };
const customer = { partyId: "c", partyType: "customer" as const, liquidity: null };
const supplier = { partyId: "s", partyType: "supplier" as const, liquidity: null };

describe("voucher line choices follow the voucher type", () => {
  it("lets JV and VR use anything on either side", () => {
    for (const type of ["JV", "VR"] as const) for (const direction of ["debit", "credit"] as const) {
      for (const choice of [cash, bank, expense, customer, supplier]) expect(lineAllows(type, "party", direction, choice)).toBe(true);
    }
  });

  it("restricts the cash or bank side to that kind of account", () => {
    expect(lineAllows("CPV", "party", "credit", cash)).toBe(true);
    expect(lineAllows("CPV", "party", "credit", bank)).toBe(false);
    expect(lineAllows("CPV", "party", "credit", expense)).toBe(false);
    expect(lineAllows("BPV", "direct", "credit", bank)).toBe(true);
    expect(lineAllows("CRV", "party", "debit", cash)).toBe(true);
    expect(lineAllows("CRV", "party", "debit", customer)).toBe(false);
    expect(lineAllows("BRV", "direct", "debit", cash)).toBe(false);
  });

  it("uses suppliers for party payments, customers for party receipts and no parties in direct mode", () => {
    expect(lineAllows("CPV", "party", "debit", supplier)).toBe(true);
    expect(lineAllows("CPV", "party", "debit", customer)).toBe(false);
    expect(lineAllows("CPV", "party", "debit", expense)).toBe(false);
    expect(lineAllows("BRV", "party", "credit", customer)).toBe(true);
    expect(lineAllows("BRV", "party", "credit", supplier)).toBe(false);
    expect(lineAllows("CPV", "direct", "debit", expense)).toBe(true);
    expect(lineAllows("CPV", "direct", "debit", supplier)).toBe(false);
    expect(lineAllows("CRV", "direct", "credit", expense)).toBe(true);
  });

  it("labels the sides of every receipt and payment", () => {
    expect(voucherSides("CPV")).toMatchObject({ settlement: "credit", liquidity: "cash", labels: { debit: "Paid to", credit: "Paid from" } });
    expect(voucherSides("BRV")).toMatchObject({ settlement: "debit", liquidity: "bank", labels: { debit: "Received in", credit: "Received from" } });
    expect(manualTypes.filter((type) => !voucherSides(type))).toEqual(["JV", "VR"]);
  });
});
