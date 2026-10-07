import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  workers: 1,
  use: {
    baseURL: process.env.TEST_BASE_URL ?? "http://127.0.0.1:3000",
    headless: true,
    launchOptions: {
      ...(process.env.CHROMIUM_PATH
        ? { executablePath: process.env.CHROMIUM_PATH }
        : {}),
    },
  },
  reporter: "list",
  webServer: process.env.TEST_BASE_URL ? undefined : {
    command: "npm run dev",
    url: "http://127.0.0.1:3000/api/v1/health",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
