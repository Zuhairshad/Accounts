import { accounts, companies, companyRoles, companySettings } from "./schema";
import type { Transaction } from "./index";
import { defaultRoles } from "../lib/permissions";

export const starterCompanies = ["AZAM ENTERPRISES", "SAKOON / KHAWAB", "ABDULLAH TRADERS"] as const;

const starterAccounts = [
  ["1000", "Cash", "asset", "cash"], ["1010", "Bank", "asset", "bank"],
  ["1100", "Accounts Receivable", "asset", "receivable"], ["1200", "Inventory", "asset", "inventory"],
  ["1500", "Fixed Assets", "asset", null], ["2000", "Accounts Payable", "liability", "payable"],
  ["2100", "Loan Payable", "liability", null], ["3000", "Owner Capital", "equity", "capital"],
  ["3100", "Drawings", "equity", null], ["4000", "Sales Revenue", "income", "sales"],
  ["4100", "Other Income", "income", null], ["5000", "Cost of Goods Sold", "expense", "cogs"],
  ["5100", "Purchases", "expense", null], ["6000", "Salaries Expense", "expense", null],
  ["6100", "Rent Expense", "expense", null], ["6200", "Utilities Expense", "expense", null],
  ["6300", "Office Expense", "expense", null], ["6400", "Entertainment Expense", "expense", null],
  ["6900", "Other Expense", "expense", null],
  ["4010", "Sales Returns", "income", "sales_returns"], ["5150", "Inventory Adjustments", "expense", "inventory_adjustment"],
  ["3200", "Retained Earnings", "equity", "retained_earnings"], ["3900", "Opening Balance Equity", "equity", "opening_equity"],
  ["1150", "Input Tax Receivable", "asset", "input_tax"], ["1160", "Withholding Receivable", "asset", "withholding_receivable"],
  ["2150", "Sales Tax Payable", "liability", "output_tax"], ["2160", "Withholding Payable", "liability", "withholding_payable"],
  ["5160", "Purchase Return Variance", "expense", "purchase_return_variance"], ["5170", "Damaged and Lost Inventory", "expense", "inventory_loss"],
  ["4020", "Service Income", "income", "service_income"], ["4030", "Freight and Transportation Income", "income", "freight_income"],
  ["5180", "Services Expense", "expense", "service_expense"], ["5190", "Freight and Transportation Expense", "expense", "freight_expense"],
] as const;

export async function insertCompany(tx: Transaction, name: string) {
  const [company] = await tx.insert(companies).values({ name }).returning();
  await tx.insert(companySettings).values({ companyId: company.id });
  await tx.insert(companyRoles).values(defaultRoles.map((role) => ({ ...role, companyId: company.id })));
  await tx.insert(accounts).values(starterAccounts.map(([code, accountName, type, control]) => ({
    companyId: company.id, code, name: accountName, type, control, liquidity: control === "cash" || control === "bank" ? control : null,
  })));
  return company;
}
