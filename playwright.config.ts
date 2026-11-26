import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.AZAM_E2E_PORT ?? 3000);
const baseURL = process.env.AZAM_E2E_BASE_URL ?? `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"], baseURL,
    // Keep a trace only when a test fails, to diagnose intermittent failures from CI artifacts.
    trace: "retain-on-failure",
    launchOptions: process.env.AZAM_CHROMIUM_PATH ? { executablePath: process.env.AZAM_CHROMIUM_PATH } : {},
  },
  webServer: process.env.AZAM_E2E_BASE_URL ? undefined : {
    command: `npm start -- --hostname 127.0.0.1 --port ${port}`, url: `${baseURL}/sign-in`, timeout: 60000,
  },
});
