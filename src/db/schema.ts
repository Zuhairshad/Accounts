import { sql } from "drizzle-orm";
import {
  boolean, check, date, foreignKey, index, integer, jsonb, numeric, pgEnum, pgTable,
  primaryKey, text, timestamp, unique, uniqueIndex, uuid, pgView,
} from "drizzle-orm/pg-core";
import type { Permission } from "../lib/permissions";

const id = () => uuid("id").defaultRandom().primaryKey();
const time = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => time("created_at").defaultNow().notNull();
const money = (name: string) => numeric(name, { precision: 20, scale: 2 });
const quantity = (name: string) => numeric(name, { precision: 24, scale: 6 });
const cost = (name: string) => numeric(name, { precision: 28, scale: 10 });
const companyId = () => uuid("company_id").notNull().references(() => companies.id);
const revision = () => integer("version").default(1).notNull();

export const accountType = pgEnum("account_type", ["asset", "liability", "equity", "income", "expense"]);
export const partyType = pgEnum("party_type", ["customer", "supplier"]);
export const documentStatus = pgEnum("document_status", ["draft", "posted", "void"]);
export const invoiceType = pgEnum("invoice_type", ["sale", "purchase", "sale_return", "purchase_return"]);
export const voucherType = pgEnum("voucher_type", ["JV", "VR", "CPV", "CRV", "BPV", "BRV", "sale", "purchase", "sale_return", "purchase_return", "opening", "adjustment", "reversal"]);

export const users = pgTable("users", {
  id: id(),
  username: text("username").notNull().unique(),
  displayName: text("display_name").notNull(),
  passwordHash: text("password_hash").notNull(),
  active: boolean("active").default(true).notNull(),
  superAdmin: boolean("super_admin").default(false).notNull(),
  mustChangePassword: boolean("must_change_password").default(true).notNull(),
  sessionVersion: integer("session_version").default(1).notNull(),
  createdAt: createdAt(),
}, (t) => [check("canonical_username", sql`${t.username} ~ '^[a-z0-9][a-z0-9_.@+-]{2,119}$'`)]);

export const loginAttempts = pgTable("login_attempts", {
  key: text("key").primaryKey(),
  hits: integer("hits").notNull(),
  expiresAt: time("expires_at").notNull(),
}, (t) => [index("login_attempt_expiry").on(t.expiresAt)]);

export const companies = pgTable("companies", {
  id: id(),
  name: text("name").notNull(),
  active: boolean("active").default(true).notNull(),
  version: revision(),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("companies_unique_name").on(sql`lower(${t.name})`),
  check("company_name_present", sql`length(btrim(${t.name})) between 1 and 160`),
]);

export const companySettings = pgTable("company_settings", {
  companyId: companyId().primaryKey(),
  logoUrl: text("logo_url"),
  address: text("address").default("").notNull(),
  phone: text("phone").default("").notNull(),
  email: text("email").default("").notNull(),
  ntn: text("ntn").default("").notNull(),
  strn: text("strn").default("").notNull(),
  timezone: text("timezone").default("Asia/Karachi").notNull(),
  currency: text("currency").default("PKR").notNull(),
  displayDateFormat: text("display_date_format").default("DD-MM-YYYY").notNull(),
  numberPrefix: text("number_prefix").default("").notNull(),
  numberPadding: integer("number_padding").default(4).notNull(),
  voucherApproval: boolean("voucher_approval").default(false).notNull(),
  tradeTax: boolean("trade_tax").default(false).notNull(),
  tradeWithholding: boolean("trade_withholding").default(false).notNull(),
  openingOffsetId: uuid("opening_offset_id"),
}, (t) => [
  check("document_padding_range", sql`${t.numberPadding} between 1 and 10`),
  foreignKey({ columns: [t.companyId, t.openingOffsetId], foreignColumns: [accounts.companyId, accounts.id] }),
]);

export const companyRoles = pgTable("company_roles", {
  id: id(), companyId: companyId(), name: text("name").notNull(),
  permissions: jsonb("permissions").$type<Permission[]>().notNull(),
  version: revision(),
}, (t) => [
  unique("role_company_id").on(t.companyId, t.id),
  unique("role_company_name").on(t.companyId, t.name),
  check("roles_permissions_array", sql`jsonb_typeof(${t.permissions}) = 'array'`),
]);

export const companyMembers = pgTable("company_members", {
  companyId: companyId(),
  userId: uuid("user_id").notNull().references(() => users.id),
  roleId: uuid("role_id").notNull(),
  createdAt: createdAt(),
}, (t) => [
  primaryKey({ columns: [t.companyId, t.userId] }),
  index("member_by_user").on(t.userId, t.companyId),
  foreignKey({ columns: [t.companyId, t.roleId], foreignColumns: [companyRoles.companyId, companyRoles.id] }),
]);

export const financialYears = pgTable("financial_years", {
  id: id(), companyId: companyId(), name: text("name").notNull(),
  startsOn: date("starts_on").notNull(), endsOn: date("ends_on").notNull(),
  closed: boolean("closed").default(false).notNull(), version: revision(),
}, (t) => [
  unique("year_company_id").on(t.companyId, t.id),
  unique("year_company_name").on(t.companyId, t.name),
  check("year_valid_range", sql`${t.startsOn} <= ${t.endsOn}`),
]);

export const periods = pgTable("accounting_periods", {
  id: id(), companyId: companyId(), yearId: uuid("year_id").notNull(),
  startsOn: date("starts_on").notNull(), endsOn: date("ends_on").notNull(),
  closed: boolean("closed").default(false).notNull(), version: revision(),
}, (t) => [
  unique("period_company_id").on(t.companyId, t.id),
  foreignKey({ columns: [t.companyId, t.yearId], foreignColumns: [financialYears.companyId, financialYears.id] }),
  check("period_valid_range", sql`${t.startsOn} <= ${t.endsOn}`),
]);

export const accounts = pgTable("accounts", {
  id: id(), companyId: companyId(), code: text("code").notNull(), name: text("name").notNull(),
  type: accountType("type").notNull(), control: text("control"), active: boolean("active").default(true).notNull(),
  parentId: uuid("parent_id"), liquidity: text("liquidity"),
  version: revision(),
}, (t) => [
  unique("account_company_id").on(t.companyId, t.id),
  unique("account_company_code").on(t.companyId, t.code),
  unique("account_company_name").on(t.companyId, t.name),
  unique("account_company_control").on(t.companyId, t.control),
  foreignKey({ columns: [t.companyId, t.parentId], foreignColumns: [t.companyId, t.id] }),
  check("valid_account_parent", sql`${t.parentId} is distinct from ${t.id}`),
  check("valid_account_liquidity", sql`${t.liquidity} is null or (${t.liquidity} in ('cash','bank') and ${t.type} = 'asset')`),
]);

export const parties = pgTable("parties", {
  id: id(), companyId: companyId(), name: text("name").notNull(), type: partyType("type").notNull(),
  phone: text("phone").default("").notNull(), address: text("address").default("").notNull(),
  contact: text("contact").default("").notNull(), email: text("email").default("").notNull(),
  ntn: text("ntn").default("").notNull(), strn: text("strn").default("").notNull(),
  creditDays: integer("credit_days").default(0).notNull(), creditLimit: money("credit_limit").default("0").notNull(),
  notes: text("notes").default("").notNull(),
  active: boolean("active").default(true).notNull(), version: revision(),
}, (t) => [
  unique("party_company_id").on(t.companyId, t.id), unique("party_company_name").on(t.companyId, t.type, t.name),
  check("valid_party_credit", sql`${t.creditDays} between 0 and 3650 and ${t.creditLimit} >= 0 and ${t.creditLimit} <> 'NaN'`),
]);

/** Company-local sales staff credited with sale invoices and customer receipts. Deactivation keeps history linked. */
export const salesExecutives = pgTable("sales_executives", {
  id: id(), companyId: companyId(), name: text("name").notNull(), phone: text("phone").default("").notNull(),
  active: boolean("active").default(true).notNull(), version: revision(), createdAt: createdAt(),
}, (t) => [
  unique("sales_executive_company_id").on(t.companyId, t.id),
  unique("sales_executive_company_name").on(t.companyId, t.name),
  check("sales_executive_name_present", sql`length(btrim(${t.name})) between 1 and 120`),
]);

export const units = pgTable("inventory_units", {
  id: id(), companyId: companyId(), name: text("name").notNull(),
}, (t) => [unique("unit_company_id").on(t.companyId, t.id), unique("unit_company_name").on(t.companyId, t.name)]);

export const items = pgTable("inventory_items", {
  id: id(), companyId: companyId(), unitId: uuid("unit_id").notNull(),
  name: text("name").notNull(), sku: text("sku"), active: boolean("active").default(true).notNull(),
  description: text("description").default("").notNull(), category: text("category").default("").notNull(),
  kind: text("kind").default("stock").notNull(), reorder: quantity("reorder_quantity").default("0").notNull(),
  purchaseAccountId: uuid("purchase_account_id"),
  version: revision(),
}, (t) => [
  unique("item_company_id").on(t.companyId, t.id),
  unique("item_company_sku").on(t.companyId, t.sku),
  unique("item_company_name").on(t.companyId, t.name),
  foreignKey({ columns: [t.companyId, t.unitId], foreignColumns: [units.companyId, units.id] }),
  foreignKey({ columns: [t.companyId, t.purchaseAccountId], foreignColumns: [accounts.companyId, accounts.id] }),
  check("inventory_item_kind", sql`${t.kind} in ('stock','service') and ${t.reorder} >= 0 and ${t.reorder} <> 'NaN'`),
]);

export const vouchers = pgTable("vouchers", {
  id: id(), companyId: companyId(), periodId: uuid("period_id").notNull(),
  number: text("number"), date: date("accounting_date").notNull(), type: voucherType("type").notNull(),
  narration: text("narration").default("").notNull(), status: documentStatus("status").default("draft").notNull(),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: createdAt(), postedAt: time("posted_at"), version: revision(),
}, (t) => [
  unique("voucher_company_id").on(t.companyId, t.id),
  unique("voucher_company_number").on(t.companyId, t.number),
  index("voucher_company_date").on(t.companyId, t.date, t.status),
  foreignKey({ columns: [t.companyId, t.periodId], foreignColumns: [periods.companyId, periods.id] }),
  check("posted_voucher_metadata", sql`${t.status} <> 'posted' or (${t.number} is not null and ${t.postedAt} is not null)`),
]);

export const voucherDocuments = pgTable("voucher_documents", {
  id: id(), companyId: companyId(), type: voucherType("type").notNull(),
  number: text("number"), date: date("accounting_date").notNull(),
  reference: text("reference").default("").notNull(),
  status: documentStatus("status").default("draft").notNull(),
  currentVoucherId: uuid("current_voucher_id"),
  draft: jsonb("draft"),
  submittedBy: uuid("submitted_by").references(() => users.id),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  source: text("source").default("manual").notNull(),
  sourceId: uuid("source_id"),
  openingPartyId: uuid("opening_party_id"), openingAccountId: uuid("opening_account_id"),
  salesExecutiveId: uuid("sales_executive_id"),
  version: revision(), createdAt: createdAt(),
}, (t) => [
  unique("voucher_document_company_id").on(t.companyId, t.id),
  unique("voucher_document_number").on(t.companyId, t.number),
  unique("voucher_document_source").on(t.companyId, t.source, t.sourceId),
  unique("voucher_document_opening_party").on(t.companyId, t.openingPartyId),
  unique("voucher_document_opening_account").on(t.companyId, t.openingAccountId),
  index("voucher_document_company_date").on(t.companyId, t.date, t.status),
  foreignKey({ columns: [t.companyId, t.currentVoucherId], foreignColumns: [vouchers.companyId, vouchers.id] }),
  foreignKey({ columns: [t.companyId, t.openingPartyId], foreignColumns: [parties.companyId, parties.id] }),
  foreignKey({ columns: [t.companyId, t.openingAccountId], foreignColumns: [accounts.companyId, accounts.id] }),
  foreignKey({ columns: [t.companyId, t.salesExecutiveId], foreignColumns: [salesExecutives.companyId, salesExecutives.id] }),
  index("voucher_document_sales_executive").on(t.companyId, t.salesExecutiveId),
  check("voucher_document_source_values", sql`${t.source} in ('manual','opening','invoice','inventory_adjustment')`),
  check("voucher_document_link", sql`(${t.source} = 'manual' and ${t.sourceId} is null and ${t.openingPartyId} is null and ${t.openingAccountId} is null)
    or (${t.source} = 'opening' and ${t.type} = 'opening' and ${t.sourceId} is null and num_nonnulls(${t.openingPartyId}, ${t.openingAccountId}) = 1)
    or (${t.source} in ('invoice', 'inventory_adjustment') and ${t.sourceId} is not null and ${t.openingPartyId} is null and ${t.openingAccountId} is null)`),
  check("posted_document_voucher", sql`${t.status} <> 'posted' or (${t.currentVoucherId} is not null and ${t.number} is not null and ${t.draft} is null)`),
  check("draft_document_payload", sql`${t.status} <> 'draft' or (${t.draft} is not null and ${t.currentVoucherId} is null)`),
]);

export const voucherVersions = pgTable("voucher_versions", {
  companyId: companyId(), documentId: uuid("document_id").notNull(), voucherId: uuid("voucher_id").notNull(),
}, (t) => [
  primaryKey({ columns: [t.companyId, t.voucherId] }),
  unique("voucher_version_document").on(t.companyId, t.documentId, t.voucherId),
  foreignKey({ columns: [t.companyId, t.documentId], foreignColumns: [voucherDocuments.companyId, voucherDocuments.id] }),
  foreignKey({ columns: [t.companyId, t.voucherId], foreignColumns: [vouchers.companyId, vouchers.id] }),
]);

export const effectiveVouchers = pgView("effective_vouchers", {
  id: uuid("id").notNull(), documentId: uuid("document_id").notNull(), companyId: uuid("company_id").notNull(),
  periodId: uuid("period_id").notNull(), date: date("accounting_date").notNull(),
  number: text("number").notNull(), reference: text("reference").notNull(),
  type: voucherType("type").notNull(), narration: text("narration").notNull(), createdAt: time("created_at").notNull(),
}).existing();

export const journalLines = pgTable("journal_lines", {
  id: id(), companyId: companyId(), voucherId: uuid("voucher_id").notNull(), accountId: uuid("account_id").notNull(),
  partyId: uuid("party_id"), itemId: uuid("item_id"), lineNo: integer("line_no").notNull(),
  debit: money("debit").notNull().default("0"), credit: money("credit").notNull().default("0"),
  description: text("description").default("").notNull(),
}, (t) => [
  unique("journal_company_id").on(t.companyId, t.id),
  unique("journal_voucher_line").on(t.companyId, t.voucherId, t.lineNo),
  index("journal_by_account").on(t.companyId, t.accountId),
  index("journal_by_party").on(t.companyId, t.partyId),
  foreignKey({ columns: [t.companyId, t.voucherId], foreignColumns: [vouchers.companyId, vouchers.id] }),
  foreignKey({ columns: [t.companyId, t.accountId], foreignColumns: [accounts.companyId, accounts.id] }),
  foreignKey({ columns: [t.companyId, t.partyId], foreignColumns: [parties.companyId, parties.id] }),
  foreignKey({ columns: [t.companyId, t.itemId], foreignColumns: [items.companyId, items.id] }),
  check("positive_journal_line", sql`${t.lineNo} > 0 and ((${t.debit} > 0 and ${t.credit} = 0) or (${t.credit} > 0 and ${t.debit} = 0))`),
]);

export const invoices = pgTable("invoices", {
  id: id(), companyId: companyId(), number: text("number"), type: invoiceType("type").notNull(),
  date: date("accounting_date").notNull(), dueOn: date("due_on"), partyId: uuid("party_id").notNull(),
  voucherId: uuid("voucher_id"), originalInvoiceId: uuid("original_invoice_id"),
  total: money("total").notNull(), partyAmount: money("party_amount"), appliedCredit: money("applied_credit"),
  externalRef: text("external_ref").default("").notNull(), poRef: text("po_ref").default("").notNull(),
  exchangeReturnId: uuid("exchange_return_id"), createdBy: uuid("created_by").references(() => users.id),
  duplicateReason: text("duplicate_reason").default("").notNull(),
  payload: jsonb("payload"), calculation: jsonb("calculation"), effectHash: text("effect_hash"),
  status: documentStatus("status").default("draft").notNull(), salesExecutiveId: uuid("sales_executive_id"),
  createdAt: createdAt(), version: revision(),
}, (t) => [
  unique("invoice_company_id").on(t.companyId, t.id),
  unique("invoice_company_number").on(t.companyId, t.type, t.number),
  unique("invoice_company_voucher").on(t.companyId, t.voucherId),
  index("invoice_company_date").on(t.companyId, t.date, t.status),
  index("invoice_original_index").on(t.companyId, t.originalInvoiceId),
  index("invoice_external_reference").on(t.companyId, t.partyId, sql`lower(${t.externalRef})`),
  uniqueIndex("one_posted_exchange_sale").on(t.companyId, t.exchangeReturnId).where(sql`${t.exchangeReturnId} is not null and ${t.status} = 'posted'`),
  foreignKey({ columns: [t.companyId, t.partyId], foreignColumns: [parties.companyId, parties.id] }),
  foreignKey({ columns: [t.companyId, t.voucherId], foreignColumns: [vouchers.companyId, vouchers.id] }),
  foreignKey({ columns: [t.companyId, t.originalInvoiceId], foreignColumns: [t.companyId, t.id] }),
  foreignKey({ columns: [t.companyId, t.exchangeReturnId], foreignColumns: [t.companyId, t.id] }),
  foreignKey({ columns: [t.companyId, t.salesExecutiveId], foreignColumns: [salesExecutives.companyId, salesExecutives.id] }),
  index("invoice_sales_executive").on(t.companyId, t.salesExecutiveId),
  check("trade_party_amount_range", sql`(${t.partyAmount} is null or ${t.partyAmount} between 0 and ${t.total}) and
    (${t.appliedCredit} is null or (${t.partyAmount} is not null and ${t.appliedCredit} between 0 and ${t.partyAmount}))`),
  check("posted_invoice_metadata", sql`${t.status} <> 'posted' or (${t.number} is not null and ${t.voucherId} is not null)`),
  check("invoice_nonnegative_total", sql`${t.total} >= 0`),
]);

export const invoiceLines = pgTable("invoice_lines", {
  id: id(), companyId: companyId(), invoiceId: uuid("invoice_id").notNull(), itemId: uuid("item_id").notNull(),
  lineNo: integer("line_no").notNull(), qty: quantity("quantity").notNull(),
  rate: cost("rate").notNull(), amount: money("amount").notNull(),
  postingVoucherId: uuid("posting_voucher_id"), originalLineNo: integer("original_line_no"),
  unitLabel: text("unit_label").default("").notNull(), description: text("description").default("").notNull(),
  subtotal: money("subtotal").default("0").notNull(), discount: money("discount").default("0").notNull(),
  tax: money("tax").default("0").notNull(), inventoryCost: money("inventory_cost").default("0").notNull(),
  disposition: text("disposition").default("saleable").notNull(), lineType: text("line_type").default("product").notNull(),
}, (t) => [
  unique("invoice_line_company_id").on(t.companyId, t.id),
  uniqueIndex("legacy_invoice_line_number").on(t.companyId, t.invoiceId, t.lineNo).where(sql`${t.postingVoucherId} is null`),
  uniqueIndex("versioned_invoice_line_number").on(t.companyId, t.invoiceId, t.postingVoucherId, t.lineNo),
  foreignKey({ columns: [t.companyId, t.postingVoucherId], foreignColumns: [vouchers.companyId, vouchers.id] }),
  foreignKey({ columns: [t.companyId, t.invoiceId], foreignColumns: [invoices.companyId, invoices.id] }),
  foreignKey({ columns: [t.companyId, t.itemId], foreignColumns: [items.companyId, items.id] }),
  check("invoice_line_values", sql`${t.lineNo} > 0 and ${t.qty} > 0 and ${t.rate} >= 0 and ${t.amount} >= 0`),
  check("invoice_line_type", sql`${t.lineType} in ('product','services','freight')`),
  index("invoice_line_posting").on(t.companyId, t.postingVoucherId),
]);

export const stockMoves = pgTable("stock_movements", {
  id: id(), companyId: companyId(), itemId: uuid("item_id").notNull(), voucherId: uuid("voucher_id").notNull(),
  date: date("accounting_date").notNull(), qty: quantity("signed_quantity").notNull(),
  unitCost: cost("unit_cost").notNull(), value: money("signed_value").notNull(), createdAt: createdAt(),
  lineNo: integer("line_no").default(0).notNull(), movementKind: text("movement_kind").default("legacy").notNull(),
}, (t) => [
  unique("stock_move_company_id").on(t.companyId, t.id),
  index("stock_company_item_date").on(t.companyId, t.itemId, t.date),
  foreignKey({ columns: [t.companyId, t.itemId], foreignColumns: [items.companyId, items.id] }),
  foreignKey({ columns: [t.companyId, t.voucherId], foreignColumns: [vouchers.companyId, vouchers.id] }),
  check("valid_stock_move", sql`${t.unitCost} >= 0 and
    ((${t.qty} = 0 and ${t.value} <> 0 and ${t.movementKind} = 'valuation') or
    (${t.qty} <> 0 and (${t.value} = 0 or sign(${t.value}) = sign(${t.qty}))))`),
]);

export const inventoryValuations = pgTable("inventory_valuations", {
  companyId: companyId(), moveId: uuid("stock_movement_id").notNull(), qty: quantity("quantity_after").notNull(),
  value: money("value_after").notNull(), averageCost: cost("average_cost").notNull(),
}, (t) => [
  primaryKey({ columns: [t.companyId, t.moveId] }),
  foreignKey({ columns: [t.companyId, t.moveId], foreignColumns: [stockMoves.companyId, stockMoves.id] }),
  check("nonnegative_inventory_valuation", sql`${t.qty} >= 0 and ${t.value} >= 0 and ${t.averageCost} >= 0`),
]);

export const inventoryAdjustments = pgTable("inventory_adjustments", {
  id: id(), companyId: companyId(), voucherId: uuid("voucher_id"), itemId: uuid("item_id"),
  number: text("number"), date: date("accounting_date"), kind: text("kind"),
  status: documentStatus("status").default("posted").notNull(), version: revision(),
  createdBy: uuid("created_by").references(() => users.id), payload: jsonb("payload"),
  calculation: jsonb("calculation"), effectHash: text("effect_hash"),
  reason: text("reason").notNull(), createdAt: createdAt(),
}, (t) => [
  unique("adjustment_company_id").on(t.companyId, t.id),
  unique("adjustment_voucher").on(t.companyId, t.voucherId),
  unique("adjustment_number").on(t.companyId, t.number),
  uniqueIndex("one_initial_inventory_opening").on(t.companyId, t.itemId).where(sql`${t.kind} = 'opening'`),
  index("adjustment_company_date").on(t.companyId, t.date),
  foreignKey({ columns: [t.companyId, t.voucherId], foreignColumns: [vouchers.companyId, vouchers.id] }),
  foreignKey({ columns: [t.companyId, t.itemId], foreignColumns: [items.companyId, items.id] }),
]);

export const openingBalances = pgTable("opening_balances", {
  id: id(), companyId: companyId(), yearId: uuid("year_id").notNull(), journalLineId: uuid("journal_line_id").notNull(),
}, (t) => [
  unique("opening_balance_line").on(t.companyId, t.journalLineId),
  foreignKey({ columns: [t.companyId, t.yearId], foreignColumns: [financialYears.companyId, financialYears.id] }),
  foreignKey({ columns: [t.companyId, t.journalLineId], foreignColumns: [journalLines.companyId, journalLines.id] }),
]);

export const allocations = pgTable("payment_allocations", {
  id: id(), companyId: companyId(), invoiceId: uuid("invoice_id").notNull(),
  paymentLineId: uuid("payment_line_id").notNull(), amount: money("amount").notNull(),
  date: date("accounting_date").notNull(), createdAt: createdAt(),
  endedOn: date("ended_on"), endedBy: uuid("ended_by").references(() => users.id),
}, (t) => [
  index("allocation_invoice_payment").on(t.companyId, t.invoiceId, t.paymentLineId),
  index("allocation_by_payment").on(t.companyId, t.paymentLineId),
  check("allocation_end_valid", sql`(${t.endedOn} is null and ${t.endedBy} is null) or (${t.endedOn} is not null and ${t.endedBy} is not null and ${t.endedOn} >= ${t.date})`),
  foreignKey({ columns: [t.companyId, t.invoiceId], foreignColumns: [invoices.companyId, invoices.id] }),
  foreignKey({ columns: [t.companyId, t.paymentLineId], foreignColumns: [journalLines.companyId, journalLines.id] }),
  check("allocation_positive_amount", sql`${t.amount} > 0`),
]);

export const documentSequences = pgTable("document_sequences", {
  companyId: companyId(), yearId: uuid("year_id").notNull(), kind: text("kind").notNull(),
  lastValue: integer("last_value").default(0).notNull(),
}, (t) => [
  primaryKey({ columns: [t.companyId, t.yearId, t.kind] }),
  foreignKey({ columns: [t.companyId, t.yearId], foreignColumns: [financialYears.companyId, financialYears.id] }),
  check("sequence_nonnegative", sql`${t.lastValue} >= 0`),
]);

export const idempotencyRequests = pgTable("idempotency_requests", {
  companyId: companyId(), operation: text("operation").notNull(), key: uuid("key").notNull(),
  actorId: uuid("actor_id").notNull().references(() => users.id),
  requestHash: text("request_hash").notNull(), result: jsonb("result"), createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.companyId, t.operation, t.key] })]);

export const dayBookEntries = pgTable("day_book_entries", {
  id: id(), companyId: companyId(), journalLineId: uuid("journal_line_id").notNull(),
}, (t) => [
  unique("day_book_source").on(t.companyId, t.journalLineId),
  foreignKey({ columns: [t.companyId, t.journalLineId], foreignColumns: [journalLines.companyId, journalLines.id] }),
]);

export const tradeRegisterEntries = pgTable("sale_purchase_register_entries", {
  id: id(), companyId: companyId(), invoiceId: uuid("invoice_id").notNull(),
}, (t) => [
  unique("trade_register_source").on(t.companyId, t.invoiceId),
  foreignKey({ columns: [t.companyId, t.invoiceId], foreignColumns: [invoices.companyId, invoices.id] }),
]);

export const revisions = pgTable("transaction_revisions", {
  id: id(), companyId: companyId(), entityType: text("entity_type").notNull(),
  entityId: uuid("entity_id").notNull(), version: integer("version").notNull(),
  actorId: uuid("actor_id").notNull().references(() => users.id),
  previousData: jsonb("previous_data").notNull(), nextData: jsonb("next_data"), reason: text("reason").notNull(), createdAt: createdAt(),
}, (t) => [unique("transaction_revision_version").on(t.companyId, t.entityType, t.entityId, t.version)]);

export const deletedRecords = pgTable("deleted_records", {
  id: id(), companyId: companyId(), entityType: text("entity_type").notNull(), entityId: uuid("entity_id").notNull(),
  reason: text("reason").notNull(), deletedBy: uuid("deleted_by").notNull().references(() => users.id),
  deletedAt: time("deleted_at").defaultNow().notNull(),
}, (t) => [unique("deleted_company_id").on(t.companyId, t.id)]);

export const restorationHistory = pgTable("restoration_history", {
  id: id(), companyId: companyId(), deletionId: uuid("deletion_id").notNull(),
  restoredBy: uuid("restored_by").notNull().references(() => users.id), reason: text("reason").notNull(),
  createdAt: createdAt(),
}, (t) => [
  unique("one_restore_per_deletion").on(t.companyId, t.deletionId),
  foreignKey({ columns: [t.companyId, t.deletionId], foreignColumns: [deletedRecords.companyId, deletedRecords.id] }),
]);

export const auditLogs = pgTable("audit_logs", {
  id: id(), companyId: uuid("company_id").references(() => companies.id),
  actorId: uuid("actor_id").references(() => users.id), action: text("action").notNull(),
  data: jsonb("data").default({}).notNull(), createdAt: createdAt(),
}, (t) => [index("audit_company_time").on(t.companyId, t.createdAt)]);

export const reportSettings = pgTable("report_settings", {
  companyId: companyId(), key: text("key").notNull(), settings: jsonb("settings").notNull(), version: revision(),
}, (t) => [primaryKey({ columns: [t.companyId, t.key] })]);

export const operationHistory = pgTable("migration_backup_history", {
  id: id(), kind: text("kind").notNull(), reference: text("reference").notNull(),
  status: text("status").notNull(), details: jsonb("details").default({}).notNull(), createdAt: createdAt(),
}, (t) => [check("valid_operation_kind", sql`${t.kind} in ('legacy_import', 'backup', 'restore')`)]);

export const reportAccountMappings = pgTable("report_account_mappings", {
  companyId: companyId(), accountId: uuid("account_id").notNull(),
  groupKey: text("group_key"), label: text("label").default("").notNull(),
  type: accountType("type").notNull(), otherExpense: boolean("other_expense").default(false).notNull(),
}, (t) => [
  primaryKey({ columns: [t.companyId, t.accountId] }),
  foreignKey({ columns: [t.companyId, t.accountId], foreignColumns: [accounts.companyId, accounts.id] }),
  check("report_mapping_key", sql`${t.groupKey} is null or ${t.groupKey} ~ '^[a-z0-9_-]{1,50}$'`),
]);

export const manualRegisterRows = pgTable("manual_register_rows", {
  id: id(), companyId: companyId(), register: text("register").notNull(),
  date: date("accounting_date"), payload: jsonb("payload").notNull(),
  status: text("status").default("draft").notNull(), version: revision(),
  linkedVoucherId: uuid("linked_voucher_id"), linkedInvoiceId: uuid("linked_invoice_id"),
  createdBy: uuid("created_by").notNull().references(() => users.id), createdAt: createdAt(),
}, (t) => [
  unique("manual_register_company_id").on(t.companyId,t.id),
  index("manual_register_range").on(t.companyId,t.register,t.date,t.status),
  unique("manual_register_voucher").on(t.companyId,t.register,t.linkedVoucherId),
  unique("manual_register_invoice").on(t.companyId,t.register,t.linkedInvoiceId),
  foreignKey({ columns: [t.companyId,t.linkedVoucherId], foreignColumns: [voucherDocuments.companyId,voucherDocuments.id] }),
  foreignKey({ columns: [t.companyId,t.linkedInvoiceId], foreignColumns: [invoices.companyId,invoices.id] }),
  check("manual_register_kind", sql`${t.register} in ('day-book','sale-purchase')`),
  check("manual_register_status", sql`${t.status} in ('draft','saved','void','linked')`),
  check("manual_register_link", sql`(${t.status} <> 'linked' and ${t.linkedVoucherId} is null and ${t.linkedInvoiceId} is null)
    or (${t.status}='linked' and ((${t.register}='day-book' and ${t.linkedVoucherId} is not null and ${t.linkedInvoiceId} is null)
    or (${t.register}='sale-purchase' and ${t.linkedInvoiceId} is not null and ${t.linkedVoucherId} is null)))`),
]);

export const voucherTimeline = pgTable("voucher_timeline", {
  companyId: companyId(), documentId: uuid("document_id").notNull(),
  version: integer("version").notNull(), recordedAt: timestamp("recorded_at", { withTimezone: true }).default(sql`clock_timestamp()`).notNull(),
  voucherId: uuid("voucher_id"), date: date("accounting_date").notNull(),
  number: text("number"), reference: text("reference").default("").notNull(),
  status: documentStatus("status").notNull(), type: voucherType("type").notNull(), draft: jsonb("draft"),
}, (t) => [
  primaryKey({ columns: [t.companyId,t.documentId,t.version] }),
  index("voucher_timeline_cutoff").on(t.companyId,t.recordedAt,t.documentId),
  foreignKey({ columns: [t.companyId,t.documentId], foreignColumns: [voucherDocuments.companyId,voucherDocuments.id] }),
  foreignKey({ columns: [t.companyId,t.voucherId], foreignColumns: [vouchers.companyId,vouchers.id] }),
]);

/** One row per committed legacy SQLite import. A source database fingerprint can be committed only once. */
export const legacyImports = pgTable("legacy_imports", {
  id: id(), sourceSha256: text("source_sha256").notNull(), mappingSha256: text("mapping_sha256").notNull(),
  reportSha256: text("report_sha256").notNull(), status: text("status").default("committed").notNull(),
  approvedBy: text("approved_by").notNull(), approval: jsonb("approval").notNull(), summary: jsonb("summary").notNull(),
  createdAt: createdAt(), withdrawnAt: time("withdrawn_at"), withdrawReason: text("withdraw_reason"),
}, (t) => [
  uniqueIndex("legacy_import_once").on(t.sourceSha256).where(sql`${t.status} = 'committed'`),
  check("legacy_import_status", sql`${t.status} in ('committed','withdrawn')`),
  check("legacy_import_withdrawal", sql`(${t.status} = 'withdrawn') = (${t.withdrawnAt} is not null and ${t.withdrawReason} is not null)`),
]);

/** Legacy identifier to target identifier map. Quarantined legacy rows keep their raw source data and have no target. */
export const legacyImportRecords = pgTable("legacy_import_records", {
  importId: uuid("import_id").notNull().references(() => legacyImports.id), companyId: uuid("company_id").references(() => companies.id),
  entity: text("entity").notNull(), legacyId: text("legacy_id").notNull(), targetId: uuid("target_id"),
  outcome: text("outcome").notNull(), issue: text("issue"), source: jsonb("source"),
}, (t) => [
  primaryKey({ columns: [t.importId, t.entity, t.legacyId] }),
  check("legacy_record_outcome", sql`${t.outcome} in ('imported','reused','quarantined','skipped')`),
  check("legacy_record_target", sql`(${t.outcome} in ('imported','reused')) = (${t.targetId} is not null)`),
]);
