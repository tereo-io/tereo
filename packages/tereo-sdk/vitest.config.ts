import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The logger (utils/logger.ts) requires both.
    env: { LOG_LEVEL: "silent", SERVICE_NAME: "sdk-tests" },
  },
});
