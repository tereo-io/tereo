import { loadTestEnv, loadUnitTestEnv } from "./src/tests/setup/testEnv.js";
import { TAGS } from "./src/tests/setup/tags.js";
import { defineConfig } from "vitest/config";

// Vitest evaluates every project's config whichever one is selected, and
// `loadTestEnv()` throws without `.env`, which the unit step in CI has not
// got. So a missing `.env` leaves `int`'s env empty here; its globalSetup
// calls `loadTestEnv()` again and fails with the real message.
function intEnv(): Record<string, string> {
  try {
    return loadTestEnv();
  } catch {
    return {};
  }
}

const base = {
  globals: true,
  environment: "node" as const,
  slowTestThreshold: 1000,
};

export default defineConfig({
  test: {
    tags: TAGS,
    strictTags: true,
    projects: [
      {
        test: {
          ...base,
          name: "unit",
          include: ["src/tests/**/*.unit.test.ts"],
          env: loadUnitTestEnv(),
          testTimeout: 10_000,
        },
      },
      {
        test: {
          ...base,
          name: "int",
          include: ["src/tests/**/*.test.ts"],
          exclude: ["src/tests/**/*.unit.test.ts"],
          env: intEnv(),
          testTimeout: 30000,
          hookTimeout: 60000,
          setupFiles: ["src/tests/setup/setup.ts"],
          globalSetup: ["src/tests/setup/globalSetup.ts"],
          // Serial across files: every file shares one server and database, and
          // the files tests race on shared state (orphan-blob cleanup, content-blob
          // refcounts) that trips legitimate server-side guards when run in parallel.
          pool: "forks",
          fileParallelism: false,
        },
      },
    ],
  },
});
