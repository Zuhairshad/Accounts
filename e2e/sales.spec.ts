import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, test, type Page } from "@playwright/test";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../src/db/schema";
import { insertCompany } from "../src/db/seed";
import { hashPassword } from "../src/lib/password";

const url = process.env.AZAM_TEST_DATABASE_URL;
const password = "Isolated sales executive browser password";
let companyId: string;
let user: string;
let customer: string;
const root = () => `/workspace/${companyId}`;

test.beforeAll(async () => {
  if (!url) return;
  if (!new URL(url).pathname.endsWith("_test")) throw new Error("Use an isolated _test database for the sales browser test.");
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  try {
    const suffix = randomUUID().slice(0, 8);
    user = `sales-browser-${suffix}`;
    customer = `Sales customer ${suffix}`;
    const passwordHash = await hashPassword(password);
    await db.transaction(async (tx) => {
      companyId = (await insertCompany(tx, `Sales browser ${suffix}`)).id;
      await tx.insert(schema.users).values({ username: user, displayName: "Sales browser operator", passwordHash, superAdmin: true, mustChangePassword: false });
      await tx.insert(schema.parties).values({ companyId, type: "customer", name: customer });
      const [year] = await tx.insert(schema.financialYears).values({ companyId, name: "2026", startsOn: "2026-01-01", endsOn: "2026-12-31" }).returning();
      await tx.insert(schema.periods).values({ companyId, yearId: year.id, startsOn: "2026-01-01", endsOn: "2026-12-31" });
      const [unit] = await tx.insert(schema.units).values({ companyId, name: "trip" }).returning();
      const [office] = await tx.select().from(schema.accounts).where(and(eq(schema.accounts.companyId, companyId), eq(schema.accounts.code, "6300")));
      await tx.insert(schema.items).values({ companyId, unitId: unit.id, name: "Delivery", sku: "DLV", kind: "service", purchaseAccountId: office.id });
    });
  } finally { await pool.end(); }
});

async function signIn(page: Page) {
  await page.goto("/sign-in");
  await page.getByLabel("Username").fill(user);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/workspace\//);
}

test("adds sales executives, posts a freight sale and a receipt, and reports them by executive", async ({ page }) => {
  test.skip(!url, "An isolated PostgreSQL database is required");
  test.setTimeout(90000);
  await signIn(page);

  await page.goto(`${root()}/accounting/sales-executives`);
  for (const name of ["Executive Amna", "Executive Bilal"]) {
    await page.getByLabel("Sales executive name").first().fill(name);
    await page.getByRole("button", { name: "Add sales executive" }).click();
    await expect(page.getByRole("cell", { name, exact: true })).toBeVisible();
  }
  const bilal = page.getByRole("row").filter({ hasText: "Executive Bilal" });
  await bilal.getByText("Edit Executive Bilal").click();
  await bilal.getByLabel("Status").selectOption("false");
  await bilal.getByRole("button", { name: "Save sales executive" }).click();
  await expect(bilal.locator(".tag")).toHaveText("Inactive");

  await page.goto(`${root()}/trade/invoices/new?type=sale`);
  await page.getByRole("combobox", { name: "Customer", exact: true }).selectOption({ label: customer });
  await expect(page.getByRole("combobox", { name: "Sales executive" }).getByRole("option")).toHaveText(["No sales executive", "Executive Amna"]);
  await page.getByRole("combobox", { name: "Sales executive" }).selectOption({ label: "Executive Amna" });
  await page.getByLabel("Accounting date").fill("2026-03-10");
  await page.getByLabel("Line type line 1").selectOption({ label: "Freight / Transportation" });
  await page.getByRole("combobox", { name: "Item line 1" }).selectOption({ label: "DLV · Delivery (service)" });
  await page.getByLabel("Quantity line 1").fill("1");
  await page.getByLabel("Rate line 1").fill("500");
  await page.getByRole("button", { name: "Post document" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^SI-20260310-/);
  await expect(page.getByText("Executive Amna")).toBeVisible();
  await expect(page.getByRole("cell", { name: "Freight / Transportation" })).toBeVisible();
  const pdf = await page.request.get((await page.getByRole("link", { name: "Download PDF" }).getAttribute("href"))!);
  expect((await pdf.body()).subarray(0, 4).toString()).toBe("%PDF");

  await page.goto(`${root()}/accounting/receipts`);
  await page.getByLabel("Received date").fill("2026-03-12");
  await page.getByLabel("Customer").selectOption({ label: customer });
  await expect(page.getByLabel("Sales executive")).toHaveValue(/[0-9a-f-]{36}/);
  await expect(page.getByLabel("Sales executive").locator("option:checked")).toHaveText("Executive Amna");
  await page.getByLabel("Received into").selectOption({ label: "Cash (CRV)" });
  await page.getByLabel("Amount received (PKR)").fill("200");
  await page.getByRole("button", { name: "Post receipt" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^CRV-20260312-/);
  await expect(page.getByText("Executive Amna")).toBeVisible();

  await page.goto(`${root()}/reports/sales-executives?from=2026-03-01&to=2026-03-31`);
  const heading = page.getByRole("row").filter({ has: page.getByRole("button", { name: "Executive Amna" }) });
  await expect(heading).toContainText("500.00");
  await expect(heading).toContainText("200.00");
  await expect(heading).toContainText("300.00");
  const receiptRow = page.getByRole("row").filter({ hasText: /CRV-20260312-/ });
  await expect(receiptRow).toBeVisible();
  await page.getByRole("button", { name: "Executive Amna" }).click();
  await expect(receiptRow).toBeHidden();
  await expect(page.getByRole("row").filter({ hasText: "Grand total" })).toContainText("300.00");
  await page.getByRole("button", { name: "Executive Amna" }).click();
  await expect(receiptRow).toBeVisible();
  const sheet = await page.request.get((await page.getByRole("link", { name: "Download Excel" }).getAttribute("href"))!);
  expect(sheet.status()).toBe(200);

  await page.goto(`${root()}/reports/company-wise?company=${companyId}&from=2026-03-01&to=2026-03-31`);
  await expect(page.getByRole("columnheader").nth(1)).toHaveText("Account Type");
  const freightRow = page.getByRole("row").filter({ hasText: "Freight and Transportation Income" });
  await expect(freightRow).toBeVisible();
  await page.getByRole("button", { name: "Income" }).click();
  await expect(freightRow).toBeHidden();
  await page.getByRole("button", { name: "Income" }).click();
  await expect(freightRow).toBeVisible();
});
