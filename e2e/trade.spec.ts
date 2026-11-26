import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../src/db/schema";
import { insertCompany } from "../src/db/seed";
import { hashPassword } from "../src/lib/password";

const url = process.env.AZAM_TEST_DATABASE_URL;
const password = "Isolated Phase 3 browser password";
let companyId: string;
let user: string;
let supplier: string;
let customer: string;
const base = () => `/workspace/${companyId}/trade`;

test.beforeAll(async () => {
  if (!url) return;
  if (!new URL(url).pathname.endsWith("_test")) throw new Error("Use an isolated _test database for the trade browser test.");
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  try {
    const suffix = randomUUID().slice(0,8);
    user = `trade-browser-${suffix}`;
    supplier = `Browser supplier ${suffix}`;
    customer = `Browser customer ${suffix}`;
    const passwordHash = await hashPassword(password);
    await db.transaction(async (tx) => {
      companyId = (await insertCompany(tx, `Trade browser ${suffix}`)).id;
      await tx.insert(schema.users).values({ username: user, displayName: "Trade browser operator", passwordHash, superAdmin: true, mustChangePassword: false });
      await tx.insert(schema.parties).values([{ companyId, type: "customer", name: customer }]);
      const [year] = await tx.insert(schema.financialYears).values({ companyId, name: "2026", startsOn: "2026-01-01", endsOn: "2026-12-31" }).returning();
      await tx.insert(schema.periods).values({ companyId, yearId: year.id, startsOn: "2026-01-01", endsOn: "2026-12-31" });
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

test("posts a purchase, sale and linked return through the browser and verifies the official stock and PDF", async ({ page }) => {
  test.skip(!url, "An isolated PostgreSQL database is required");
  test.setTimeout(90000);
  await signIn(page);
  await page.goto(`${base()}/invoices/new?type=purchase`);
  await page.getByLabel("External invoice or reference number").fill("BROWSER-SUPPLIER-REF");
  await page.getByText("Add supplier without leaving this invoice").click();
  await page.getByRole("textbox", { name: "Party name" }).fill(supplier);
  await page.getByRole("button", { name: "Add supplier" }).click();
  await expect(page.getByRole("option", { name: supplier })).toBeAttached();
  await page.getByText("Add item or service without leaving this invoice").click();
  await page.getByLabel("Item code or SKU").fill("BRW-200");
  await page.getByLabel("Item name").fill("Browser stock");
  await page.getByRole("button", { name: "Add item", exact: true }).click();
  await expect(page.getByRole("option", { name: /BRW-200 · Browser stock/ })).toBeAttached();
  await expect(page.getByLabel("External invoice or reference number")).toHaveValue("BROWSER-SUPPLIER-REF");
  await page.getByRole("combobox", { name: "Supplier", exact: true }).selectOption({ label: supplier });
  await page.getByLabel("Accounting date").fill("2026-02-10");
  await page.getByLabel("Due date").fill("2026-03-10");
  await page.getByRole("combobox", { name: "Item line 1" }).selectOption({ label: "BRW-200 · Browser stock" });
  await page.getByLabel("Quantity line 1").fill("10");
  await page.getByLabel("Rate line 1").fill("1000");
  await page.getByRole("button", { name: "Post document" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^PI-20260210-/);
  const inventoryHref = await page.getByRole("link", { name: "Browser stock", exact: true }).getAttribute("href");

  await page.goto(`${base()}/invoices/new?type=sale`);
  await page.getByRole("combobox", { name: "Customer", exact: true }).selectOption({ label: customer });
  await page.getByLabel("Accounting date").fill("2026-02-11");
  await page.getByLabel("Due date").fill("2026-03-11");
  await page.getByRole("combobox", { name: "Item line 1" }).selectOption({ label: "BRW-200 · Browser stock" });
  await page.getByLabel("Quantity line 1").fill("4");
  await page.getByLabel("Rate line 1").fill("1500");
  await page.getByRole("button", { name: "Post document" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^SI-20260211-/);
  await page.getByRole("link", { name: "Create return" }).click();

  await page.getByLabel("Accounting date").fill("2026-02-12");
  await page.getByLabel("Return reason").fill("One saleable unit returned");
  await page.getByLabel("Quantity line 1").fill("1");
  await page.getByRole("button", { name: "Post document" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^SR-20260212-/);
  const pdfPath = await page.getByRole("link", { name: "Download PDF" }).getAttribute("href");
  const pdf = await page.request.get(pdfPath!);
  expect(pdf.status()).toBe(200);
  expect((await pdf.body()).subarray(0,4).toString()).toBe("%PDF");

  await page.goto(`${inventoryHref}?from=2026-02-01&to=2026-02-28`);
  await expect(page.getByRole("heading", { name: "Stock ledger" })).toBeVisible();
  await expect(page.getByText("7 unit", { exact: true })).toBeVisible();
  await expect(page.getByText("7,000.00 PKR", { exact: true })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "sale return" })).toContainText("7,000.00");

  await page.goto(`${base()}/invoices?from=2026-02-01&to=2026-02-28`);
  await expect(page.getByRole("row").filter({ hasText: "Browser stock" })).toHaveCount(3);
  await page.getByText("1 item line").first().click();
  await expect(page.getByText(/Browser stock · 1 unit/)).toBeVisible();
});
