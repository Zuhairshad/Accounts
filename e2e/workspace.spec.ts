import { expect, test, type Page } from "@playwright/test";

const testAdmin = process.env.AZAM_E2E_ADMIN;
const adminPassword = process.env.AZAM_E2E_PASSWORD;
const newPassword = "Updated isolated test password only";
const memberPassword = "Initial isolated member password only";

async function login(page: Page, username: string, password: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

async function updatePassword(page: Page, current: string, updated: string) {
  await expect(page.getByRole("heading", { name: "Change password" })).toBeVisible();
  await page.getByLabel("Current password").fill(current);
  await page.getByLabel("New password", { exact: true }).fill(updated);
  await page.getByLabel("Confirm new password").fill(updated);
  await page.getByRole("button", { name: "Save password" }).click();
  await expect(page.getByRole("status")).toContainText("Password saved");
}

test("unauthenticated requests go to sign-in", async ({ page }) => {
  await page.goto("/workspace");
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("admin sets up a company and a viewer can only open an assigned workspace", async ({ page, browser }) => {
  test.skip(!testAdmin || !adminPassword, "An isolated database and bootstrapped test administrator are required.");
  const username = `viewer-${Date.now()}`;
  const company = `PHASE 1 TEST ${Date.now()}`;
  const renamed = `${company} RENAMED`;

  await login(page, testAdmin!, adminPassword!);
  await updatePassword(page, adminPassword!, newPassword);
  await login(page, testAdmin!, newPassword);
  await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
  await expect(page.getByText("No posted vouchers yet.")).toBeVisible();
  const otherWorkspace = page.url();
  const search = page.getByRole("textbox", { name: "Global search" });
  await search.fill("cash");
  await search.press("Enter");
  await expect(page.getByRole("heading", { name: /Results.*cash/ })).toBeVisible();
  await expect(page.getByText("Cash", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Company directory" }).click();
  await page.getByLabel("Company name").fill(company);
  await page.getByRole("button", { name: "Create company" }).click();
  const row = page.getByRole("row").filter({ hasText: company });
  await expect(row).toBeVisible();
  await page.getByLabel("Display name").fill("Phase 1 Viewer");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Initial password").fill(memberPassword);
  const userForm = page.getByRole("button", { name: "Create user" }).locator("xpath=ancestor::form");
  await userForm.getByRole("button", { name: "Create user" }).click();
  await expect(userForm.getByRole("status")).toContainText("Saved.");
  await row.getByRole("link", { name: "Manage" }).click();

  const nameInput = page.getByLabel("Company name", { exact: true });
  await nameInput.fill(renamed);
  await expect(nameInput).toHaveValue(renamed);
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("heading", { name: renamed })).toBeVisible();

  await page.getByLabel("Year name").fill("FY 2026–27");
  await page.getByLabel("Start date").fill("2026-07-01");
  await page.getByLabel("End date").fill("2027-06-30");
  await page.getByRole("button", { name: "Add financial year" }).click();
  await expect(page.getByText("FY 2026–27", { exact: true })).toBeVisible();

  await page.getByLabel("Existing username").fill(username);
  await page.getByRole("combobox", { name: "Role", exact: true }).selectOption({ label: "Viewer / Auditor" });
  await page.getByRole("button", { name: "Assign role" }).click();
  await expect(page.getByText("Phase 1 Viewer", { exact: true })).toBeVisible();
  const settingsPage = page.url();

  await page.getByRole("button", { name: "Deactivate company" }).click();
  await expect(page.getByText("Inactive company", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Activate company" }).click();
  await expect(page.getByText("Active company", { exact: true })).toBeVisible();

  const viewer = await browser.newPage();
  await login(viewer, username, memberPassword);
  await updatePassword(viewer, memberPassword, `${memberPassword} updated`);
  await login(viewer, username, `${memberPassword} updated`);
  await expect(viewer.getByText(renamed, { exact: true }).last()).toBeVisible();
  await viewer.getByText("Change period", { exact: true }).click();
  await viewer.getByRole("combobox", { name: "Financial year" }).selectOption({ label: "FY 2026–27" });
  await viewer.getByRole("button", { name: "Apply filters" }).click();
  await expect(viewer.getByLabel("From")).toHaveValue("2026-07-01");
  await viewer.goto(otherWorkspace);
  await expect(viewer.getByRole("heading", { name: "Page unavailable" })).toBeVisible();
  await viewer.goto(settingsPage);
  await expect(viewer.getByRole("heading", { name: "Page unavailable" })).toBeVisible();
  await viewer.close();
});
