import { Exact } from "@/lib/engine/model";
import type { Mapping, Row } from "./source";

/*
 * Converts mapped legacy rows into a canonical dataset and records every anomaly as an issue. Nothing is silently
 * corrected: an issue states the resolution the importer would apply, and blocking resolutions are applied only when an
 * approval file accepts them (see load.ts). Fatal issues cannot be approved; the mapping or target must change.
 */

type Decimal = InstanceType<typeof Exact>;
export type Severity = "fatal" | "blocking" | "review" | "info";
export type Issue = { code: string; severity: Severity; entity: string; legacyId: string; company?: string; message: string; resolution: string };

export type LegacyCompany = { legacyId: string; name: string; targetName: string; active: boolean };
export type LegacyAccount = { legacyId: string; company: string; code: string; name: string; type: "asset" | "liability" | "equity" | "income" | "expense" };
export type LegacyParty = { legacyId: string; company: string; type: "customer" | "supplier"; name: string; importName: string; phone: string; address: string };
export type LegacyItem = { legacyId: string; company: string; name: string; unit: string; openingQty: string; openingRate: string; openingDate: string | null };
export type LegacyLine = { lineNo: number; account: string; party: string | null; debit: string; credit: string; description: string; unlinkedParty?: string };
export type LegacyVoucher = {
  legacyId: string; company: string; number: string; date: string; type: Mapping["values"]["voucherType"][string];
  narration: string; lines: LegacyLine[]; quarantine?: string;
};
export type LegacyInvoiceLine = { legacyId: string; item: string; qty: string; rate: string; amount: string };
export type LegacyInvoice = {
  key: string; company: string; number: string; date: string; type: "sale" | "purchase" | "sale_return" | "purchase_return";
  party: string | null; voucher: string; lines: LegacyInvoiceLine[]; total: string; quarantine?: string; rows: Row[];
};
export type Dataset = {
  companies: LegacyCompany[]; accounts: LegacyAccount[]; parties: LegacyParty[]; items: LegacyItem[];
  vouchers: LegacyVoucher[]; invoices: LegacyInvoice[]; orphanLines: Row[]; issues: Issue[];
  sourceCounts: Record<string, number>;
};

/** Startup renames applied by the desktop application (LEGACY_FEATURE_MAP.md, "Original company aliases"). */
export const companyAliases: Record<string, string> = {
  "AZAM ENTERPRISE": "AZAM ENTERPRISES", "AZAM TRADERS": "SAKOON / KHAWAB", "AZAM SERVICES": "ABDULLAH TRADERS",
};

const text = (value: unknown) => value === null || value === undefined ? "" : String(value).trim();
const key = (value: unknown) => text(value);

/** Accepts the four date formats the desktop entry screens accepted and returns ISO YYYY-MM-DD, or null. */
export function legacyDate(value: unknown): string | null {
  const raw = text(value).slice(0, 10);
  let y: number, m: number, d: number;
  let match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(raw);
  if (match) [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else if ((match = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(raw))) [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d || y < 1900 || y > 2199) return null;
  return date.toISOString().slice(0, 10);
}

/** Legacy amounts are SQLite REAL. Values are rounded to the given scale; a real fractional remainder is reported. */
export function legacyNumber(value: unknown, scale: number): { value: Decimal; exact: boolean } | null {
  if (value === null || value === undefined || text(value) === "") return { value: new Exact(0), exact: true };
  let parsed: Decimal;
  try { parsed = new Exact(typeof value === "number" ? value.toString() : text(value).replaceAll(",", "")); } catch { return null; }
  if (!parsed.isFinite()) return null;
  const rounded = parsed.toDecimalPlaces(scale, Exact.ROUND_HALF_UP);
  // Binary floating point noise (e.g. 0.1 + 0.2) is below 1e-9 and is not reported.
  return { value: rounded, exact: parsed.minus(rounded).abs().lt("1e-9") };
}

export function normalize(mapping: Mapping, read: (entity: keyof Mapping["tables"]) => Row[]): Dataset {
  const issues: Issue[] = [];
  const issue = (i: Issue) => { issues.push(i); };
  const raw = {
    companies: read("companies"), accounts: read("accounts"), parties: read("parties"), items: read("items"),
    vouchers: read("vouchers"), lines: read("voucherLines"), invoiceRows: read("invoiceRows"),
  };
  const sourceCounts = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v.length]));

  /* Companies */
  const companies: LegacyCompany[] = raw.companies.map((row) => {
    const name = text(row.name);
    const upper = name.toUpperCase();
    const target = mapping.companyTargets[key(row.id)];
    return { legacyId: key(row.id), name, active: row.active === undefined ? true : !["0", "false", "no", ""].includes(text(row.active).toLowerCase()),
      targetName: target && "name" in target ? target.name : companyAliases[upper] ?? name };
  });
  const companyIds = new Set(companies.map((c) => c.legacyId));
  const known = (entity: string, row: Row) => {
    const company = key(row.companyId);
    if (companyIds.has(company)) return company;
    issue({ code: "unknown-company", severity: "blocking", entity, legacyId: key(row.id ?? row.__rowid), message: `References missing company ${company || "(blank)"}.`,
      resolution: "Quarantine the record; it is not imported." });
    return null;
  };

  /* Accounts */
  const accounts: LegacyAccount[] = [];
  for (const row of raw.accounts) {
    const company = known("account", row);
    if (!company) continue;
    const type = mapping.values.accountType[text(row.type)];
    if (!type) {
      issue({ code: "unknown-account-type", severity: "fatal", entity: "account", legacyId: key(row.id), company,
        message: `Account type "${text(row.type)}" has no mapping.`, resolution: "Add the value to values.accountType." });
      continue;
    }
    accounts.push({ legacyId: key(row.id), company, code: text(row.code), name: text(row.name), type });
  }
  const accountById = new Map(accounts.map((a) => [a.legacyId, a]));

  /* Parties: identical names within one company and type cannot coexist in the target. */
  const parties: LegacyParty[] = [];
  const seen = new Map<string, string>();
  for (const row of raw.parties) {
    const company = known("party", row);
    if (!company) continue;
    const type = mapping.values.partyType[text(row.type)];
    if (!type) {
      issue({ code: "unknown-party-type", severity: "fatal", entity: "party", legacyId: key(row.id), company,
        message: `Party type "${text(row.type)}" has no mapping.`, resolution: "Add the value to values.partyType." });
      continue;
    }
    const name = text(row.name) || `Unnamed ${type} ${key(row.id)}`;
    const identity = `${company}|${type}|${name.toLowerCase()}`;
    let importName = name;
    if (seen.has(identity)) {
      importName = `${name} (legacy ${key(row.id)})`;
      issue({ code: "duplicate-party-name", severity: "blocking", entity: "party", legacyId: key(row.id), company,
        message: `${type} "${name}" duplicates legacy party ${seen.get(identity)}. They may be the same person or different people.`,
        resolution: `Import as "${importName}" without merging balances. Merge later only through reviewed journal entries.` });
    } else seen.set(identity, key(row.id));
    parties.push({ legacyId: key(row.id), company, type, name, importName, phone: text(row.phone), address: text(row.address) });
  }
  const partyById = new Map(parties.map((p) => [p.legacyId, p]));

  /* Items */
  const items: LegacyItem[] = [];
  for (const row of raw.items) {
    const company = known("item", row);
    if (!company) continue;
    const qty = legacyNumber(row.openingQty, 6);
    const rate = legacyNumber(row.openingRate, 10);
    let openingDate = row.openingDate === undefined ? null : legacyDate(row.openingDate);
    if (!qty || !rate || qty.value.lt(0) || rate.value.lt(0)) {
      issue({ code: "invalid-stock-opening", severity: "blocking", entity: "item", legacyId: key(row.id), company,
        message: `Opening quantity "${text(row.openingQty)}" or rate "${text(row.openingRate)}" is not a valid non-negative number.`,
        resolution: "Import the item without opening stock. Enter an approved opening adjustment afterwards." });
    }
    if (row.openingDate !== undefined && text(row.openingDate) && !openingDate) {
      issue({ code: "invalid-date", severity: "blocking", entity: "item", legacyId: key(row.id), company,
        message: `Opening date "${text(row.openingDate)}" is not a valid date.`, resolution: "Use the company's earliest imported date for the stock opening." });
      openingDate = null;
    }
    const valid = qty && rate && !qty.value.lt(0) && !rate.value.lt(0);
    items.push({ legacyId: key(row.id), company, name: text(row.name) || `Item ${key(row.id)}`, unit: text(row.unit) || "unit",
      openingQty: valid ? qty.value.toFixed(6) : "0.000000", openingRate: valid ? rate.value.toFixed(10) : "0", openingDate });
  }
  const itemById = new Map(items.map((i) => [i.legacyId, i]));

  /* Vouchers and their lines */
  const linesByVoucher = new Map<string, Row[]>();
  const voucherIds = new Set(raw.vouchers.map((v) => key(v.id)));
  const orphanLines: Row[] = [];
  for (const line of raw.lines) {
    const voucher = key(line.voucherId);
    if (!voucherIds.has(voucher)) {
      orphanLines.push(line);
      issue({ code: "orphan-line", severity: "blocking", entity: "voucher_line", legacyId: key(line.id ?? line.__rowid),
        message: `Journal line references missing voucher ${voucher || "(blank)"} (Dr ${text(line.debit) || 0} / Cr ${text(line.credit) || 0}).`,
        resolution: "Quarantine the line. It has no voucher, so it is excluded from the imported ledger." });
      continue;
    }
    linesByVoucher.set(voucher, [...(linesByVoucher.get(voucher) ?? []), line]);
  }

  const vouchers: LegacyVoucher[] = [];
  const numbers = new Map<string, string>();
  for (const row of raw.vouchers) {
    const company = known("voucher", row);
    if (!company) continue;
    const legacyId = key(row.id);
    const at = (code: string, severity: Severity, message: string, resolution: string) =>
      issue({ code, severity, entity: "voucher", legacyId, company, message: `${text(row.number) || legacyId}: ${message}`, resolution });
    const type = mapping.values.voucherType[text(row.type)];
    const date = legacyDate(row.date);
    const voucher: LegacyVoucher = { legacyId, company, number: text(row.number), date: date ?? "", type: type ?? "JV",
      narration: text(row.narration).slice(0, 1000), lines: [] };
    if (!type) {
      voucher.quarantine = "unknown-voucher-type";
      at("unknown-voucher-type", "blocking", `Voucher type "${text(row.type)}" has no mapping.`, "Quarantine the voucher.");
    }
    if (!date) {
      voucher.quarantine = "invalid-date";
      at("invalid-date", "blocking", `Date "${text(row.date)}" is not valid.`, "Quarantine the voucher and its ledger effect.");
    }
    if (!voucher.number) {
      voucher.number = `LEGACY-${text(row.type) || "V"}-${legacyId}`.replace(/\s+/g, "-");
      at("missing-voucher-number", "review", "Voucher has no number.", `Import as ${voucher.number}.`);
    }
    const numberKey = `${company}|${voucher.number.toLowerCase()}`;
    if (numbers.has(numberKey)) {
      const renamed = `${voucher.number}-DUP${legacyId}`;
      at("duplicate-voucher-number", "blocking", `Number also used by legacy voucher ${numbers.get(numberKey)}.`,
        `Keep the first voucher's number and import this one as ${renamed}. Both postings are kept.`);
      voucher.number = renamed;
    } else numbers.set(numberKey, legacyId);

    let lineNo = 0;
    let dr = new Exact(0), cr = new Exact(0), rawDr = new Exact(0), rawCr = new Exact(0);
    for (const line of linesByVoucher.get(legacyId) ?? []) {
      const debit = legacyNumber(line.debit, 2);
      const credit = legacyNumber(line.credit, 2);
      const lineId = key(line.id ?? line.__rowid);
      if (!debit || !credit) {
        voucher.quarantine = "invalid-amount";
        at("invalid-amount", "blocking", `Line ${lineId} has a non-numeric amount.`, "Quarantine the voucher.");
        continue;
      }
      rawDr = rawDr.plus(Exact.max(debit.value, 0)).plus(Exact.max(credit.value.negated(), 0));
      rawCr = rawCr.plus(Exact.max(credit.value, 0)).plus(Exact.max(debit.value.negated(), 0));
      if (!debit.exact || !credit.exact) at("fractional-cents", "review", `Line ${lineId} has an amount below one paisa.`, "Round half-up to two decimals and verify voucher balance.");
      const account = accountById.get(key(line.accountId));
      if (!account || account.company !== company) {
        voucher.quarantine = "unknown-account";
        at("unknown-account", "blocking", `Line ${lineId} references account ${key(line.accountId) || "(blank)"} that does not exist in this company.`,
          "Quarantine the voucher and its ledger effect.");
        continue;
      }
      // A signed amount on one side is the same as a positive amount on the other; both sides on one line are split.
      const net = debit.value.minus(credit.value);
      if (debit.value.lt(0) || credit.value.lt(0)) at("negative-amount", "review", `Line ${lineId} stores a negative amount.`, "Post the absolute value on the opposite side. The ledger effect is unchanged.");
      if (debit.value.gt(0) && credit.value.gt(0)) at("two-sided-line", "review", `Line ${lineId} has both a debit and a credit.`, "Post the net amount on one side. The ledger effect is unchanged.");
      if (net.isZero()) { if (!debit.value.isZero()) at("zero-line", "info", `Line ${lineId} nets to zero.`, "Omit the line."); continue; }
      const partyId = key(line.partyId);
      const party = partyId ? partyById.get(partyId) : undefined;
      let linked: string | null = party?.legacyId ?? null;
      if (partyId && !party) {
        at("unknown-party", "blocking", `Line ${lineId} references missing party ${partyId}.`, "Import the amount without a party for manual reconciliation.");
        linked = null;
      }
      lineNo++;
      const entry: LegacyLine = { lineNo, account: account.legacyId, party: linked, description: text(line.description).slice(0, 1000),
        debit: Exact.max(net, 0).toFixed(2), credit: Exact.max(net.negated(), 0).toFixed(2) };
      dr = dr.plus(entry.debit); cr = cr.plus(entry.credit);
      voucher.lines.push(entry);
    }
    if (!voucher.quarantine && !voucher.lines.length) {
      voucher.quarantine = "empty-voucher";
      at("empty-voucher", "info", "Voucher has no non-zero lines.", "Skip the voucher; it has no ledger effect.");
    } else if (!voucher.quarantine && (!dr.eq(cr) || voucher.lines.length < 2)) {
      voucher.quarantine = "unbalanced-voucher";
      at("unbalanced-voucher", "blocking", `Debits ${rawDr.toFixed(2)} and credits ${rawCr.toFixed(2)} do not balance after rounding (difference ${dr.minus(cr).toFixed(2)}).`,
        "Quarantine the voucher. Re-enter a balanced, approved correction in the new system.");
    }
    vouchers.push(voucher);
  }

  /* Invoice rows share a number and voucher ID; group them into one header with lines. */
  const invoices: LegacyInvoice[] = [];
  const groups = new Map<string, Row[]>();
  for (const row of raw.invoiceRows) {
    const company = known("invoice_row", row);
    if (!company) continue;
    const type = mapping.values.invoiceType[text(row.type)];
    const groupKey = `${company}|${type ?? text(row.type)}|${text(row.number)}`;
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), row]);
  }
  const voucherById = new Map(vouchers.map((v) => [v.legacyId, v]));
  const voucherOwners = new Map<string, string>();
  for (const [groupKey, rows] of groups) {
    const [company, , number] = groupKey.split("|");
    const head = rows[0];
    const type = mapping.values.invoiceType[text(head.type)];
    const invoice: LegacyInvoice = { key: groupKey, company, number: number || `LEGACY-INV-${key(head.__rowid)}`, date: legacyDate(head.date) ?? "",
      type: type ?? "sale", party: key(head.partyId) || null, voucher: key(head.voucherId), lines: [], total: "0.00", rows };
    const at = (code: string, severity: Severity, message: string, resolution: string) =>
      issue({ code, severity, entity: "invoice", legacyId: groupKey, company, message: `Invoice ${invoice.number}: ${message}`, resolution });
    const quarantine = (code: string, message: string) => {
      invoice.quarantine ??= code;
      at(code, "blocking", message, "Quarantine the invoice document. Its voucher, if valid, is still imported, so the ledger is unchanged.");
    };
    if (!type) quarantine("unknown-invoice-type", `Invoice type "${text(head.type)}" has no mapping.`);
    if (!invoice.date) quarantine("invalid-date", `Date "${text(head.date)}" is not valid.`);
    const distinct = (field: string) => new Set(rows.map((r) => text(r[field]))).size > 1;
    if (distinct("voucherId") || distinct("date") || distinct("partyId")) quarantine("inconsistent-invoice-rows", "Rows sharing this number disagree on voucher, date or party.");
    const voucher = voucherById.get(invoice.voucher);
    if (!voucher || voucher.company !== company) quarantine("invoice-without-voucher", `Linked voucher ${invoice.voucher || "(blank)"} does not exist.`);
    else if (voucher.quarantine) quarantine("invoice-voucher-quarantined", `Linked voucher ${voucher.number} is quarantined (${voucher.quarantine}).`);
    else if (voucherOwners.has(invoice.voucher)) quarantine("invoice-voucher-shared", `Voucher ${voucher.number} is already linked to invoice ${voucherOwners.get(invoice.voucher)}.`);
    else {
      voucherOwners.set(invoice.voucher, invoice.number);
      if (invoice.date && voucher.date !== invoice.date) at("invoice-date-differs", "review", `Invoice date ${invoice.date} differs from voucher date ${voucher.date}.`, "Import both dates as recorded.");
    }
    if (invoice.party && !partyById.has(invoice.party)) quarantine("unknown-party", `References missing party ${invoice.party}.`);
    if (!invoice.party && voucher) {
      const tagged = [...new Set(voucher.lines.map((l) => l.party).filter(Boolean))];
      if (tagged.length === 1) {
        invoice.party = tagged[0];
        at("invoice-party-derived", "review", "Invoice rows have no party.", `Use the only party tagged on voucher ${voucher.number}.`);
      } else quarantine("invoice-without-party", "No party on the invoice rows or a single party on its voucher.");
    }
    let total = new Exact(0);
    for (const row of rows) {
      const qty = legacyNumber(row.qty, 6), rate = legacyNumber(row.rate, 10), amount = legacyNumber(row.amount, 2);
      const item = itemById.get(key(row.itemId));
      if (!qty || !rate || !amount || !qty.value.gt(0) || rate.value.lt(0) || amount.value.lt(0)) { quarantine("invalid-invoice-line", `Row ${key(row.id ?? row.__rowid)} has an invalid quantity, rate or amount.`); continue; }
      if (!item || item.company !== company) { quarantine("unknown-item", `Row ${key(row.id ?? row.__rowid)} references a missing item.`); continue; }
      if (!amount.exact) at("fractional-cents", "review", `Row ${key(row.id ?? row.__rowid)} has an amount below one paisa.`, "Round half-up to two decimals.");
      invoice.lines.push({ legacyId: key(row.id ?? row.__rowid), item: item.legacyId, qty: qty.value.toFixed(6), rate: rate.value.toFixed(10), amount: amount.value.toFixed(2) });
      total = total.plus(amount.value);
    }
    invoice.total = total.toFixed(2);
    invoices.push(invoice);
  }

  return { companies, accounts, parties, items, vouchers, invoices, orphanLines, issues, sourceCounts };
}
