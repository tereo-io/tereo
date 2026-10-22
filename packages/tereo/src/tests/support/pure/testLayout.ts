import { ASPECTS, AREA_BY_PATH, AREA_TAGS, METHODS } from "../../setup/tags.js";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import path from "path";

export const TESTS_DIR = path.resolve(import.meta.dirname, "../..");
export const SRC_DIR = path.resolve(TESTS_DIR, "..");

export const MAX_LINES = 800;

export interface OversizeEntry {
  path: string;
  ceiling: number;
  reason: string;
}

/**
 * What is wrong with the files' sizes, given each file's line count and the
 * declared oversize list: an unlisted file over the cap, a listed file over
 * its ceiling, a listed file at or under the cap, or a listed file missing.
 */
export function oversizeProblems(
  counts: ReadonlyMap<string, number>,
  oversize: ReadonlyArray<OversizeEntry>
): string[] {
  const listed = new Map(oversize.map((e) => [e.path, e]));
  const problems: string[] = [];
  for (const [file, lines] of counts) {
    if (lines > MAX_LINES && !listed.has(file)) {
      problems.push(
        `${file}: ${lines} lines, over ${MAX_LINES} and not in oversize.ts`
      );
    }
  }
  for (const { path: file, ceiling } of oversize) {
    const lines = counts.get(file);
    if (lines === undefined)
      problems.push(`${file}: listed in oversize.ts but missing`);
    else if (lines <= MAX_LINES) {
      problems.push(
        `${file}: ${lines} lines, listed in oversize.ts but not over ${MAX_LINES}`
      );
    } else if (lines > ceiling) {
      problems.push(`${file}: ${lines} lines, over its ceiling of ${ceiling}`);
    }
  }
  return problems;
}

// The regex Vitest reads file-level tags with.
const MODULE_TAG = /(\/\/|\*)\s*@module-tag\s+([\w\-/]+)\b/g;

/** Every file under `src/tests` (paths relative to it), sorted. */
export function listFiles(
  filter: (rel: string) => boolean = () => true
): string[] {
  return readdirSync(TESTS_DIR, { recursive: true, encoding: "utf8" })
    .map((f) => f.split(path.sep).join("/"))
    .filter((f) => statSync(path.join(TESTS_DIR, f)).isFile() && filter(f))
    .sort();
}

export interface ParsedName {
  base: string;
  aspect?: string;
  method?: string;
  unit: boolean;
  /** Segments that are neither an aspect, a method nor `unit`. */
  unknown: string[];
}

/** `user.validation.patch.unit.test.ts`: `<base>[.<aspect>][.<method>][.unit].test.ts`. */
export function parseName(file: string): ParsedName {
  const [base, ...rest] = path.basename(file, ".test.ts").split(".");
  const unit = rest.at(-1) === "unit";
  if (unit) rest.pop();
  const method = (METHODS as readonly string[]).includes(rest.at(-1) ?? "")
    ? rest.pop()
    : undefined;
  const aspect = (ASPECTS as readonly string[]).includes(rest.at(-1) ?? "")
    ? rest.pop()
    : undefined;
  return { base, aspect, method, unit, unknown: rest };
}

function isRouterFolder(dir: string): boolean {
  return existsSync(path.join(SRC_DIR, dir, "index.ts"));
}

/**
 * Why `rel` (a test path under `src/tests`) maps to no source, or `null` when
 * it does: a source file, a router folder, the root router (`routes/routes`),
 * a flow, or a convention.
 */
export function mapTestPath(rel: string): string | null {
  if (!rel.endsWith(".test.ts")) return "not a *.test.ts file";
  const { base, unknown } = parseName(rel);
  if (unknown.length > 0) {
    return `undeclared name segment: ${unknown.join(".")}`;
  }
  const dir = path.posix.dirname(rel);
  if (dir === "conventions") return null;
  const [top, area, ...deeper] = dir.split("/");
  if (top === "flows") {
    return (AREA_TAGS as readonly string[]).includes(area) &&
      deeper.length === 0
      ? null
      : "flows/<area>/ must be an area folder, not nested";
  }
  const srcDir = dir === "." ? "" : dir;
  if (existsSync(path.join(SRC_DIR, srcDir, `${base}.ts`))) return null;
  if (
    srcDir.startsWith("routes") &&
    path.posix.basename(srcDir) === base &&
    isRouterFolder(srcDir)
  ) {
    return null;
  }
  return `no src/${srcDir ? `${srcDir}/` : ""}${base}.ts, and src/${srcDir} is not a router folder named ${base}`;
}

/** The `@module-tag`s in a file's leading comment block. */
export function readTags(rel: string): string[] {
  const head: string[] = [];
  for (const line of readFileSync(path.join(TESTS_DIR, rel), "utf8").split(
    "\n"
  )) {
    if (!/^\s*(\/\/|\/\*|\*|$)/.test(line)) break;
    head.push(line);
  }
  return [...head.join("\n").matchAll(MODULE_TAG)].map((m) => m[2]);
}

/** The area `rel` must carry, by the longest matching prefix in `AREA_BY_PATH`. */
export function expectedArea(rel: string): string | undefined {
  let best: readonly [string, string] | undefined;
  for (const entry of AREA_BY_PATH) {
    const [prefix] = entry;
    if (
      (rel === prefix || rel.startsWith(`${prefix}/`)) &&
      (!best || prefix.length > best[0].length)
    ) {
      best = entry;
    }
  }
  return best?.[1];
}

export function lineCount(rel: string): number {
  const text = readFileSync(path.join(TESTS_DIR, rel), "utf8");
  return text === ""
    ? 0
    : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

const IMPORT_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/g;

/** Relative imports of a file, resolved to `.ts` paths relative to `src`. */
export function resolveImports(rel: string): string[] {
  const text = readFileSync(path.join(TESTS_DIR, rel), "utf8");
  const dir = path.dirname(path.join(TESTS_DIR, rel));
  return [...text.matchAll(IMPORT_SPECIFIER)].map((m) =>
    path.relative(SRC_DIR, path.resolve(dir, m[1])).replace(/\.js$/, ".ts")
  );
}

/** Whether a `.unit` file may not import `target` (a path relative to `src`). */
export function reachesInfrastructure(target: string): boolean {
  return (
    target.startsWith("utils/db/") ||
    target === "utils/redis.ts" ||
    // The entry points start the server, database and Redis.
    target === "app.ts" ||
    target === "index.ts" ||
    target === "worker.ts" ||
    // tags.ts is a pure declaration, imported by the config as well.
    (target.startsWith("tests/setup/") && target !== "tests/setup/tags.ts") ||
    (target.startsWith("tests/support/") &&
      !target.startsWith("tests/support/pure/"))
  );
}
