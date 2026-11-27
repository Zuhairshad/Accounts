import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../src/db/schema";
import { insertCompany } from "../src/db/seed";
import { hashPassword } from "../src/lib/password";
import { karachiToday } from "../src/lib/validation";

const database = process.env.AZAM_TEST_DATABASE_URL;
const password = "Isolated phase five browser password";
const today = karachiToday();
let admin = "";
let viewer = "";
let companyId = "";

test.beforeAll(async () => {
  if (!database) return;
  if (!new URL(database).pathname.endsWith("_test")) throw new Error("Use an isolated _test database.");
  const pool = new Pool({ connectionString: database });
  const db = drizzle(pool, { schema });
  const tag = randomUUID().slice(0, 8);
  admin = `p5-admin-${tag}`;
  viewer = `p5-viewer-${tag}`;
  const passwordHash = await hashPassword(password);
  await db.transaction(async (tx) => {
    const company = await insertCompany(tx, `Phase5 E2E ${tag}`);
    companyId = company.id;
    const year = `${today.slice(0, 4)}`;
    const [fy] = await tx.insert(schema.financialYears).values({ companyId, name: `FY ${year}`, startsOn: `${year}-01-01`, endsOn: `${year}-12-31` }).returning();
    await tx.insert(schema.periods).values({ companyId, yearId: fy.id, startsOn: fy.startsOn, endsOn: fy.endsOn });
    const [, view] = await tx.insert(schema.users).values([
      { username: admin, displayName: "Phase5 admin", passwordHash, mustChangePassword: false, superAdmin: true },
      { username: viewer, displayName: "Phase5 data entry", passwordHash, mustChangePassword: false },
    ]).returning();
    const [role] = await tx.insert(schema.companyRoles).values({ companyId, name: "Entry only", permissions: ["view", "create"] }).returning();
    await tx.insert(schema.companyMembers).values({ companyId, userId: view.id, roleId: role.id });
  });
  await pool.end();
});

async function login(page: Page, username: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/workspace\//);
}

test("keyboard entry, account search, period display and reconciliation work in the browser under the production CSP", async ({ page }) => {
  test.skip(!database, "An isolated database is required.");
  const violations: string[] = [];
  page.on("console", (message) => { if (/Content Security Policy/i.test(message.text())) violations.push(message.text()); });
  await login(page, admin);
  await page.goto(`/workspace/${companyId}`);
  await expect(page.locator(".period-badge")).toContainText(`FY ${today.slice(0, 4)}`);

  await page.locator("body").press("?");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeHidden();

  await page.keyboard.press("n");
  await page.keyboard.press("v");
  await expect(page).toHaveURL(new RegExp(`/workspace/${companyId}/accounting/vouchers/new$`));
  await page.getByLabel("Accounting date").fill(today);
  await page.getByRole("searchbox", { name: "Find account or party line 1" }).fill("cash");
  await page.getByRole("searchbox", { name: "Find account or party line 1" }).press("Enter");
  await expect(page.getByLabel("Amount line 1")).toBeFocused();
  await expect(page.getByRole("combobox", { name: "Account or party line 1" }).locator("option:checked")).toHaveText(/Cash/);
  await page.getByLabel("Amount line 1").fill("750.25");
  await page.getByLabel("Amount line 1").press("Enter");
  await expect(page).toHaveURL(/vouchers\/new$/); // Enter advanced focus instead of submitting
  await page.getByRole("searchbox", { name: "Find account or party line 2" }).fill("other inc");
  await page.getByRole("searchbox", { name: "Find account or party line 2" }).press("Enter");
  await page.getByLabel("Amount line 2").fill("750.25");
  await page.getByRole("button", { name: "Post voucher", exact: true }).click();
  await expect(page).toHaveURL(/\/vouchers\/[0-9a-f-]+$/, { timeout: 15000 });

  await page.goto(`/workspace/${companyId}/reconciliation?from=${today.slice(0, 4)}-01-01&to=${today}`);
  await expect(page.getByRole("heading", { name: "Financial reconciliation" })).toBeVisible();
  await expect(page.getByText("Discrepancies").locator("..")).toContainText("0");
  await expect(page.getByRole("heading", { name: "Trial Balance balances" })).toBeVisible();
  expect(violations).toEqual([]);
});

test("reconciliation and operations history are hidden from users without permission", async ({ page }) => {
  test.skip(!database, "An isolated database is required.");
  await login(page, viewer);
  // Workspace pages stream behind a loading boundary, so a denied page renders the not-found view with HTTP 200.
  // What matters is that no reconciliation or operations data is rendered.
  for (const path of [`/workspace/${companyId}/reconciliation`, "/workspace/administration/operations"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "Page unavailable" })).toBeVisible();
    await expect(page.getByText(/Financial reconciliation|Recorded operations|Discrepancies/)).toHaveCount(0);
  }
});

test("adding a register row does not pull focus away from a field the user has already moved to", async ({ page }) => {
  test.skip(!database, "An isolated database is required.");
  await login(page, admin);
  await page.goto(`/workspace/${companyId}/reports/day-book?from=${today.slice(0, 4)}-01-01&to=${today}&perspective=manual`);
  await expect(page.getByRole("button", { name: "Add row" })).toBeVisible();
  // Hold animation frames so the test controls exactly when the grid's deferred focus step runs (a slow device).
  await page.evaluate(() => {
    const held: FrameRequestCallback[] = [];
    window.requestAnimationFrame = (callback) => { held.push(callback); return held.length; };
    (window as unknown as { flushFrames: () => void }).flushFrames = () => { while (held.length) held.shift()!(performance.now()); };
  });
  await page.getByRole("button", { name: "Add row" }).click();
  const description = page.getByRole("textbox", { name: "description row 1" });
  await description.focus();
  await page.evaluate(() => (window as unknown as { flushFrames: () => void }).flushFrames());
  await expect(description).toBeFocused();
  await page.keyboard.type("Typed straight after adding the row");
  await expect(description).toHaveValue("Typed straight after adding the row");
});

test("adding a register row still focuses its first cell when the user has not moved elsewhere", async ({ page }) => {
  test.skip(!database, "An isolated database is required.");
  await login(page, admin);
  await page.goto(`/workspace/${companyId}/reports/day-book?from=${today.slice(0, 4)}-01-01&to=${today}&perspective=manual`);
  await page.getByRole("button", { name: "Add row" }).click();
  await expect(page.locator(".register-entry tbody tr").last().getByRole("textbox").first()).toBeFocused();
});
