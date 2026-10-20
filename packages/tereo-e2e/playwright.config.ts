import { defineConfig, devices } from "@playwright/test";
import { e2e } from "./src/config.js";

const ci = !!process.env.CI;

export default defineConfig({
  testDir: "./src/tests",
  outputDir: "./test-results",
  fullyParallel: true,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  workers: ci ? 2 : 4,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: ci
    ? [["list"], ["html", { open: "never" }], ["github"]]
    : [["list"], ["html", { open: "never" }]],

  use: {
    baseURL: e2e.baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },

  projects: [
    // First-run setup through the UI, then the admin's sign-in, saved for
    // every other spec. It is itself the first-run test.
    {
      name: "setup",
      testMatch: /.*\.setup\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "chromium",
      testIgnore: /.*\.setup\.ts/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], storageState: e2e.adminStatePath },
    },
  ],

  // Recreates the e2e database, builds the UI and runs core (src/core/startCore.ts).
  webServer: {
    command: "tsx src/core/startCore.ts",
    url: `${e2e.baseURL}/health`,
    // A run owns its database, so it never shares a core, except a core
    // started with `npm run e2e:core` while iterating on specs
    // (E2E_REUSE_CORE=1): its data carries over between runs.
    reuseExistingServer: process.env.E2E_REUSE_CORE === "1",
    timeout: 300_000,
    stdout: "ignore",
    stderr: "pipe",
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
  },
});
