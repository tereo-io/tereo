import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(() => ({
  // Core serves the production build at its root, around its reserved
  // prefixes (RESERVED_PREFIXES in core's utils/ui.ts; scripts/check-routes.mjs
  // keeps routes clear of them).
  base: "/",
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    // One copy of each: @kosmeo-ui/react shares the app's React and its
    // QueryClient context, which a second copy of react-query cannot see.
    dedupe: ["react", "react-dom", "@tanstack/react-query"],
  },
  build: {
    outDir: "./dist",
    emptyOutDir: true,
  },
  plugins: [react()],
  server: {
    // Core's UI_BASE_URL defaults to http://localhost:4000 outside
    // production: its CORS origin, the seeded login client's redirect URI,
    // and where it sends consent and org-select redirects.
    port: 4000,
    strictPort: true,
  },
}));
