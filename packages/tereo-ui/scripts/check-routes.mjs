// Fails when a router path, or a file in public/, sits under a path core keeps
// for itself. Core serves this UI at its root and answers those prefixes
// itself, so such a page could never load.
//
// Keep in step with RESERVED_PREFIXES in
// packages/tereo/src/utils/ui.ts (core's test image has no UI
// source to import from).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const RESERVED = ["v1", "oauth", ".well-known", "health", "ws", "assets"];

const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appDir = path.join(uiRoot, "src/app");
const publicDir = path.join(uiRoot, "public");

const firstSegment = (p) => p.replace(/^\/+/, "").split("/")[0];

const problems = [];
for (const file of readdirSync(appDir, { recursive: true, encoding: "utf8" })) {
  if (!/\.(ts|tsx)$/.test(file)) continue;
  const lines = readFileSync(path.join(appDir, file), "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/path:\s*["']([^"']+)["']/g)) {
      if (RESERVED.includes(firstSegment(m[1]))) {
        problems.push(`src/app/${file}:${i + 1}: route "${m[1]}"`);
      }
    }
  });
}
if (existsSync(publicDir)) {
  for (const entry of readdirSync(publicDir)) {
    if (RESERVED.includes(entry)) problems.push(`public/${entry}`);
  }
}

if (problems.length) {
  console.error(
    `check-routes: these sit under a path core reserves (/${RESERVED.join(", /")}):\n  ${problems.join("\n  ")}`
  );
  process.exit(1);
}
console.log("check-routes: no route under a reserved prefix");
