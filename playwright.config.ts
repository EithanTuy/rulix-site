import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: "line",
  outputDir: path.join(os.tmpdir(), "rulix-playwright-results"),
  use: {
    baseURL: "http://127.0.0.1:8789",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  projects: [
    {
      name: "desktop",
      testMatch: /rulix-smoke\.spec\.ts$/,
      use: { browserName: "chromium", viewport: { width: 1440, height: 1024 } }
    },
    {
      name: "tablet",
      testMatch: /rulix-smoke\.spec\.ts$/,
      use: { browserName: "chromium", viewport: { width: 768, height: 1024 } }
    },
    {
      name: "mobile",
      testMatch: /rulix-smoke\.spec\.ts$/,
      use: { browserName: "chromium", viewport: { width: 390, height: 844 } }
    },
    {
      name: "demo-1280",
      testMatch: /rulix-demo-readiness\.spec\.ts$/,
      use: { browserName: "chromium", viewport: { width: 1280, height: 720 } }
    },
    {
      name: "demo-1366",
      testMatch: /rulix-demo-readiness\.spec\.ts$/,
      use: { browserName: "chromium", viewport: { width: 1366, height: 768 } }
    }
  ],
  webServer: {
    command: "npm run e2e:server",
    url: "http://127.0.0.1:8789/api/health",
    reuseExistingServer: false,
    timeout: 120_000
  }
});
