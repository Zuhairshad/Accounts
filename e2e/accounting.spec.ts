import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { Client } from "pg";
import { hashPassword } from "../src/lib/password";

const database = process.env.AZAM_TEST_DATABASE_URL;
const testPassword = "Isolated finance workflow password";
const today = "2026-10-04";
let admin: string;
let viewer: string;
let companyId: string;
let otherCompanyId: string;
const route = () => `/workspace/${companyId}/accounting`;

test.beforeAll(async () => {
  if (!database) return;
  if (!new URL(database).pathname.endsWith("_test")) throw new Error("Run finance browser tests only in an isolated database ending in _test.");
  const connection = new Client({ connectionString: database });
  await connection.connect();
  const tag = randomUUID().slice(0, 8);
  admin = `finance-admin-${tag}`;
  viewer = `finance-viewer-${tag}`;
  const passwordHash = await hashPassword(testPassword);
  try {
    await connection.query("begin");
    const companies = await connection.query<{ id: string }>(
      "insert into companies(name) values($1),($2) returning id", [`Finance E2E ${tag}`, `Finance other ${tag}`],
    );
    companyId = companies.rows[0].id;
    otherCompanyId = companies.rows[1].id;
    await connection.query("insert into company_settings(company_id) values($1),($2)", [companyId, otherCompanyId]);
    await connection.query(`insert into accounts(company_id,code,name,type,control,liquidity) values
      ($1,'1000','Cash','asset','cash','cash'),($1,'1010','Bank','asset','bank','bank'),
      ($1,'1100','Accounts Receivable','asset','receivable',null),($1,'2000','Accounts Payable','liability','payable',null),
      ($1,'3900','Opening Balance Equity','equity','opening_equity',null),($1,'4100','Other Income','income',null,null)`, [companyId]);
    const user = await connection.query<{ id: string }>(
      "insert into users(username,display_name,password_hash,must_change_password,super_admin) values ($1,'Finance admin',$3,false,true),($2,'Finance viewer',$3,false,false) returning id",
      [admin, viewer, passwordHash],
    );
    const role = await connection.query<{ id: string }>("insert into company_roles(company_id,name,permissions) values($1,'Viewer','[\"view\"]') returning id", [companyId]);
    await connection.query("insert into company_members(company_id,user_id,role_id) values ($1,$2,$3)", [companyId, user.rows[1].id, role.rows[0].id]);
    const year = await connection.query<{ id: string }>(
      "insert into financial_years(company_id,name,starts_on,ends_on) values($1,'FY 2026','2026-01-01','2026-12-31') returning id", [companyId],
    );
    await connection.query(
      "insert into accounting_periods(company_id,year_id,starts_on,ends_on) values($1,$2,'2026-01-01','2026-12-31')", [companyId, year.rows[0].id],
    );
    await connection.query("commit");
  } finally {
    await connection.end();
  }
});

async function login(page: Page, username: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(testPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/workspace\//);
}

test("posts and reopens receivables through the browser, exports PDF, and enforces viewer scope", async ({ page, browser }) => {
  test.skip(!database, "An isolated database is required.");
  test.setTimeout(75000);
  await login(page, admin);
  await page.goto(`${route()}/parties/new`);
  await page.getByLabel("Party name").fill("Receivables browser customer");
  await page.getByLabel("Save opening balance with party").check();
  await page.getByLabel("Opening balance date").fill("2026-10-01");
  await page.getByLabel("Opening balance amount").fill("10000");
  await page.getByLabel("Opening reason").fill("Approved opening balance");
  await page.getByRole("button", { name: "Create party" }).click();
  await expect(page).toHaveURL(/\/parties\/[0-9a-f-]+$/);
  const partyAccount = page.url().split("/").at(-1)!;
  await expect(page.getByText("PKR 10000.00 Dr")).toBeVisible();

  await page.goto(`${route()}/vouchers/new`);
  await page.getByRole("combobox", { name: "Voucher type" }).selectOption("CRV");
  await page.getByLabel("Accounting date").fill(today);
  await page.getByLabel("Reference").fill("BROWSER-RECEIPT");
  await page.getByRole("combobox", { name: "Account or party line 2" }).selectOption({ label: "Receivables browser customer · customer" });
  await page.getByLabel("Amount line 1").fill("4000");
  await page.getByLabel("Amount line 2").fill("4000");
  await page.getByRole("button", { name: "Post voucher", exact: true }).click();
  await expect(page).toHaveURL(/\/vouchers\/[0-9a-f-]+$/, { timeout: 15000 });
  const voucherUrl = page.url();
  const voucherId = voucherUrl.split("/").at(-1)!;
  const number = await page.getByRole("heading", { level: 1 }).textContent();
  expect(number).toMatch(/^CRV-20261004-/);
  const pdf = await page.request.get(`/api/accounting/${companyId}/vouchers/${voucherId}`);
  expect(pdf.status()).toBe(200);
  expect((await pdf.body()).subarray(0, 4).toString()).toBe("%PDF");
  expect(pdf.headers()["content-disposition"]).toContain("attachment");
  const print = await page.request.get(`/api/accounting/${companyId}/vouchers/${voucherId}?inline=1`);
  expect(print.headers()["content-disposition"]).toContain("inline");

  const openLedger = async () => {
    await page.goto(`${route()}/party-ledger/${partyAccount}?from=2026-10-02&to=2026-10-31`);
    await expect(page.getByText("Opening balance (PKR)")).toBeVisible();
  };
  await openLedger();
  await expect(page.getByText("6,000.00 Dr", { exact: true }).first()).toBeVisible();
  await page.goto(voucherUrl);
  await page.getByText("Void voucher", { exact: true }).click();
  await page.getByLabel("Reason").fill("Receipt temporarily voided");
  await page.getByRole("button", { name: "Confirm void voucher" }).click();
  await expect(page.getByText("Voided", { exact: true })).toBeVisible();
  await page.goto(`${route()}/recycle`);
  await expect(page.getByRole("row").filter({ hasText: "Receipt temporarily voided" }).getByRole("link", { name: "Preview and restore" })).toBeVisible();
  await openLedger();
  await expect(page.getByText("10,000.00 Dr", { exact: true })).toHaveCount(2);
  await page.goto(voucherUrl);
  await page.getByText("Restore voucher", { exact: true }).click();
  await page.getByLabel("Reason", { exact: true }).first().fill("Original receipt restored");
  await page.getByRole("button", { name: "Confirm restore voucher" }).click();
  await expect(page.getByText("posted", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(number!);
  await openLedger();
  await expect(page.getByText("6,000.00 Dr", { exact: true }).first()).toBeVisible();
  await page.goto(`${route()}/debtors?asOf=2026-10-31`);
  await expect(page.getByRole("row").filter({ hasText: "Receivables browser customer" })).toContainText("6,000.00 Dr");

  const readOnly = await browser.newPage();
  try {
    await login(readOnly, viewer);
    await readOnly.goto(voucherUrl);
    await expect(readOnly.getByRole("heading", { level: 1 })).toHaveText(number!);
    await expect(readOnly.getByRole("link", { name: "Edit voucher" })).toHaveCount(0);
    expect((await readOnly.request.get(`/api/accounting/${companyId}/vouchers/${voucherId}`)).status()).toBe(404);
    await readOnly.goto(`${route()}/vouchers/new`);
    await expect(readOnly.getByRole("heading", { name: "Page unavailable" })).toBeVisible();
    await readOnly.goto(`/workspace/${otherCompanyId}/accounting/vouchers`);
    await expect(readOnly.getByRole("heading", { name: "Page unavailable" })).toBeVisible();
  } finally {
    await readOnly.close();
  }
});
