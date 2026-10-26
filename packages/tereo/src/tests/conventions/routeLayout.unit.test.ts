// @module-tag unit
// @module-tag platform
import { readdirSync, readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "url";
import path from "path";

// The layout rules for src/routes (see the routes skill): routes are wired
// in index.ts, one router each; handlers live in controllers.ts, route-local
// middleware in middleware.ts, Zod schemas in schemas.ts; a :param route is
// mounted from its own singular folder.
const ROUTES = fileURLToPath(new URL("../../routes", import.meta.url));

const files = readdirSync(ROUTES, { recursive: true, encoding: "utf8" })
  .filter((f) => f.endsWith(".ts"))
  .map((f) => ({
    file: f,
    source: readFileSync(path.join(ROUTES, f), "utf8"),
  }));
const indexFiles = files.filter(
  ({ file }) => path.basename(file) === "index.ts"
);

const REGISTRATION = /\.(get|post|put|patch|delete|head|all|use)\(\s*["'`]/;
const PATH_LITERAL =
  /\.(get|post|put|patch|delete|head|all|use)\(\s*["'`]([^"'`]*)["'`]/g;

const offending = (
  predicate: (entry: { file: string; source: string }) => boolean
) => files.filter(predicate).map(({ file }) => file);

describe("route layout", () => {
  it("finds the route files", () => {
    expect(indexFiles.length).toBeGreaterThan(50);
  });

  it("creates routers only in index.ts, one each", () => {
    expect(
      offending(({ file, source }) => {
        const count = (source.match(/\bRouter\(/g) ?? []).length;
        return path.basename(file) === "index.ts" ? count > 1 : count > 0;
      })
    ).toEqual([]);
  });

  it("registers routes only in index.ts", () => {
    expect(
      offending(
        ({ file, source }) =>
          path.basename(file) !== "index.ts" && REGISTRATION.test(source)
      )
    ).toEqual([]);
  });

  it("defines no functions in index.ts", () => {
    expect(
      indexFiles
        .filter(({ source }) => /=>|\bfunction\b/.test(source))
        .map(({ file }) => file)
    ).toEqual([]);
  });

  it("builds Zod schemas only in schemas.ts", () => {
    expect(
      offending(
        ({ file, source }) =>
          path.basename(file) !== "schemas.ts" && /\bz\.[a-z]+\(/.test(source)
      )
    ).toEqual([]);
  });

  it("mounts each :param from its own folder, one segment at a time", () => {
    const stray = indexFiles.flatMap(({ file, source }) =>
      [...source.matchAll(PATH_LITERAL)]
        .filter(([, method, route]) => {
          const segments = route.split("/").filter(Boolean);
          const dynamic = segments.some((s) => /^[:*]/.test(s));
          if (!dynamic) return false;
          return method !== "use" || segments.length !== 1;
        })
        .map(([match]) => `${file}: ${match}`)
    );
    expect(stray).toEqual([]);
  });
});
