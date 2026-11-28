import { z } from "zod";
import { Exact } from "@/lib/engine/model";
import { formatMoney } from "@/lib/display";
import { displayDate } from "@/lib/validation";

export const reportTitles = {
  mis: "Daily MIS", "trial-balance": "Trial Balance", "general-ledger": "General Ledger", "party-ledger": "Party Ledger",
  "profit-loss": "Profit & Loss", "balance-sheet": "Balance Sheet", debtors: "Debtors Report", creditors: "Creditors Report",
  aging: "Invoice Aging", "voucher-register": "Voucher Register", "invoice-register": "Invoice Register",
  "inventory-valuation": "Inventory Valuation", "stock-ledger": "Stock Ledger", adjustments: "Inventory Adjustment Report",
  sales: "Sales Summary", purchases: "Purchase Summary", "sales-executives": "Sales Executive wise Sale Report", "sales-returns": "Sale Return Report", "purchase-returns": "Purchase Return Report",
  "cash-bank": "Cash and Bank Ledgers", "company-wise": "Company-wise Report", "combined-heads": "Combined Company Report",
  "combined-parties": "Combined Debtors & Creditors List", "day-book": "Day Book", "sale-purchase": "Sale / Purchase",
} as const;
export type ReportId = keyof typeof reportTitles;
export type RegisterId = "day-book" | "sale-purchase";
export const combinedIds = ["company-wise", "combined-heads", "combined-parties"] as const;
export const isReport = (id: string): id is ReportId => Object.hasOwn(reportTitles, id);
export const isRegister = (id: string): id is RegisterId => id === "day-book" || id === "sale-purchase";
export const cashViews = ["cash", "bank", "manual"] as const;

export type Cell = { value: string; kind?: "money" | "date" | "quantity" | "integer"; href?: string };
/**
 * `toggle` marks a heading row whose `parent` rows the web view can collapse. Print, PDF and spreadsheet exports
 * ignore both fields and always show every row.
 */
export type ReportRow = {
  key: string; cells: Cell[]; style?: "section" | "group" | "total" | "warning"; group?: string; toggle?: string; parent?: string;
};
export type PrintLayout = { margin: number; rowHeight: number; widths: number[]; slots: number };

export type ReportDocument = {
  id: ReportId; title: string; scope: string[]; companyDetails: string[];
  from: string; to: string; generatedAt: string; columns: string[]; rows: ReportRow[];
  notes: string[]; warning?: string; layout?: PrintLayout;
};

export type ReportFilter = {
  from: string; to: string; mode: string; account?: string; main?: string; party?: string; item?: string;
  voucherType?: string; voucher?: string; invoice?: string; classification?: string;
  status: "posted" | "draft" | "void" | "all"; recordedAt?: string; includeOpening: boolean;
  search: string; perspective: typeof cashViews[number]; blank: boolean; deleted: boolean; group?: string;
};

export const textCell = (value: string | null | undefined, href?: string): Cell => ({ value: value ?? "", href });
export const dateCell = (value: string | null): Cell => ({ value: value ?? "", kind: "date" });
export const moneyCell = (value: string | InstanceType<typeof Exact>, href?: string): Cell =>
  ({ kind: "money", value: new Exact(value).toFixed(2), href });
export const quantityCell = (value: string): Cell => ({ kind: "quantity", value: new Exact(value).toString() });
export const integerCell = (value: number | string): Cell => ({ kind: "integer", value: String(value) });
export const showCell = (cell: Cell) => !cell.value ? "" : cell.kind === "money" ? formatMoney(cell.value)
  : cell.kind === "date" ? displayDate(cell.value) : cell.value;
export const sum = <T,>(rows: T[], getter: (row: T) => string | InstanceType<typeof Exact>) =>
  rows.reduce((total, row) => total.plus(getter(row)), new Exact(0));
export function blankCell(kind?: Cell["kind"]): Cell { return { value: "", kind }; }

export const registerColumns = {
  "sale-purchase": ["Sr #", "Date", "Vr/Inv #", "Description/Supplier/Customer", "VR Type", "Purch Amount", "Sale Amount"],
  "day-book": ["Sr #", "Date", "Vr Type", "Description/Supplier/Customer", "Dr", "Cr", "Bal"],
};
export const defaults: Record<RegisterId, PrintLayout> = {
  "sale-purchase": { margin: 58, rowHeight: 16, widths: [5,11,9,33,15,14,13], slots: 32 },
  "day-book": { margin: 58, rowHeight: 16, widths: [5,11,9,33,15,14,13], slots: 39 },
};
export const layoutSchema = z.object({
  margin: z.coerce.number().int().min(18).max(70), rowHeight: z.coerce.number().int().min(12).max(32),
  widths: z.array(z.coerce.number().min(4).max(55)).length(7), slots: z.coerce.number().int().min(10).max(50),
});
