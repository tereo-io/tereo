import { loadTestEnv } from "./src/tests/testEnv.js";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 30000,
    hookTimeout: 60000,
    slowTestThreshold: 1000,
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/tests/setup.ts"],
    globalSetup: ["src/tests/globalSetup.ts"],
    env: loadTestEnv(),
    // Serial across files: every file shares one server and database, and
    // the files tests race on shared state (orphan-blob cleanup, content-blob
    // refcounts) that trips legitimate server-side guards when run in parallel.
    pool: "forks",
    fileParallelism: false,
  },
});
