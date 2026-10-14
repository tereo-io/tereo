import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: "@", replacement: path.resolve(__dirname, "./src") },
      // This package keeps its own React beside a newer one at the workspace
      // root, which Testing Library and react-query resolve; tests need one.
      ...["react", "react-dom"].map((name) => ({
        find: new RegExp(`^${name}(/|$)`),
        replacement: `${path.resolve(__dirname, "../../node_modules", name)}$1`,
      })),
    ],
    dedupe: ["react", "react-dom", "@tanstack/react-query"],
  },
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    server: {
      deps: { inline: [/@testing-library/, /@kosmeo-ui\//, /@tanstack\//] },
    },
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
