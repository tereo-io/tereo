// @module-tag unit
// @module-tag platform
import { LEGACY_PATHS } from "./legacyPaths.js";
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "fs";
import path from "path";
import {
  MAX_LINES,
  TESTS_DIR,
  expectedArea,
  lineCount,
  listFiles,
  mapTestPath,
  parseName,
  reachesInfrastructure,
  readTags,
  resolveImports,
} from "../support/pure/testLayout.js";
import {
  AREA_TAGS,
  ASPECTS,
  DETAIL_TAGS,
  METHODS,
  TAGS,
  TIER_TAGS,
} from "../setup/tags.js";

// The rules in src/tests/README.md. Every rule lists the offending paths,
// and skips the files still in LEGACY_PATHS.
const legacy = new Set(LEGACY_PATHS);
const testFiles = () =>
  listFiles((f) => f.endsWith(".test.ts") && !legacy.has(f));
const unitFiles = () => testFiles().filter((f) => parseName(f).unit);
const KNOWN_TAGS = new Set<string>(TAGS.map((t) => t.name));

describe("path mapping", () => {
  it.each([
    "routes/v1/admin/users/user/user.test.ts",
    "routes/v1/admin/users/user/user.validation.patch.unit.test.ts",
    "routes/v1/admin/users/user/user.permissions.test.ts",
    "routes/routes.permissions.test.ts",
    "utils/permissions.unit.test.ts",
    "utils/db/index.test.ts",
    "jobs/lifecycleSweep.test.ts",
    "index.test.ts",
    "app.test.ts",
    "flows/auth/authorizationCode.test.ts",
    "conventions/testLayout.unit.test.ts",
  ])("maps %s", (rel) => {
    expect(mapTestPath(rel)).toBeNull();
  });

  it.each([
    ["routes/v1/admin/users/user/users.test.ts", "not a router folder"],
    ["jobs/jobs.test.ts", "no src/jobs/jobs.ts"],
    ["utils/db/db.test.ts", "no src/utils/db/db.ts"],
    ["utils/nope.test.ts", "no src/utils/nope.ts"],
    ["routes/v1/admin/users/user/user.misc.test.ts", "undeclared name segment"],
    [
      "routes/v1/admin/users/user/user.validation.put.patch.test.ts",
      "undeclared",
    ],
    [
      "routes/v1/admin/users/user.test.ts",
      "no src/routes/v1/admin/users/user.ts",
    ],
    ["flows/nope/something.test.ts", "area folder"],
    ["flows/auth/deeper/something.test.ts", "area folder"],
    ["nope.test.ts", "no src/nope.ts"],
    ["utils/permissions.ts", "not a *.test.ts"],
  ])("rejects %s", (rel, why) => {
    expect(mapTestPath(rel)).toContain(why);
  });

  it("parses the filename grammar", () => {
    expect(parseName("a/user.validation.patch.unit.test.ts")).toEqual({
      base: "user",
      aspect: "validation",
      method: "patch",
      unit: true,
      unknown: [],
    });
  });
});

describe("test layout", () => {
  it("maps every test file to a source file, router folder, flow or convention", () => {
    const offenders = testFiles().flatMap((f) => {
      const why = mapTestPath(f);
      return why ? [`${f}: ${why}`] : [];
    });
    expect(offenders).toEqual([]);
  });

  it("tags every file with exactly one tier, matching its name", () => {
    const offenders = testFiles().flatMap((f) => {
      const tiers = readTags(f).filter((t) =>
        (TIER_TAGS as readonly string[]).includes(t)
      );
      const want = parseName(f).unit ? "unit" : "int";
      return tiers.length === 1 && tiers[0] === want
        ? []
        : [`${f}: needs exactly one tier tag, "${want}"; has [${tiers}]`];
    });
    expect(offenders).toEqual([]);
  });

  it("tags every file with an area, matching its path", () => {
    const offenders = testFiles().flatMap((f) => {
      const areas = readTags(f).filter((t) =>
        (AREA_TAGS as readonly string[]).includes(t)
      );
      const expected = expectedArea(f);
      if (areas.length === 0) return [`${f}: no area tag`];
      if (expected && areas[0] !== expected) {
        return [
          `${f}: path requires ${expected} as the first area tag, has ${areas.join(", ")}`,
        ];
      }
      return [];
    });
    expect(offenders).toEqual([]);
  });

  it(`keeps every file under src/tests within ${MAX_LINES} lines`, () => {
    const offenders = listFiles(
      (f) => f.endsWith(".ts") && !f.startsWith("fixtures/") && !legacy.has(f)
    ).flatMap((f) =>
      lineCount(f) > MAX_LINES ? [`${f}: ${lineCount(f)} lines`] : []
    );
    expect(offenders).toEqual([]);
  });

  it("keeps unit files off the database, server and Redis", () => {
    const offenders = unitFiles().flatMap((f) =>
      resolveImports(f)
        .filter(reachesInfrastructure)
        .map((target) => `${f} imports src/${target}`)
    );
    expect(offenders).toEqual([]);
  });

  it("uses only declared aspects, methods and tags", () => {
    const offenders = testFiles().flatMap((f) => {
      const { unknown } = parseName(f);
      const problems = unknown.map(
        (s) =>
          `undeclared aspect or method "${s}" (aspects: ${ASPECTS.join(", ")}; methods: ${METHODS.join(", ")})`
      );
      for (const tag of readTags(f)) {
        if (!KNOWN_TAGS.has(tag)) problems.push(`undeclared tag "${tag}"`);
      }
      return problems.map((p) => `${f}: ${p}`);
    });
    expect(offenders).toEqual([]);
  });

  it("lists the same tags in README.md as tags.ts", () => {
    const readme = path.join(TESTS_DIR, "README.md");
    expect(existsSync(readme), "src/tests/README.md is missing").toBe(true);
    const rows = [
      ...readFileSync(readme, "utf8").matchAll(
        /^\|\s*`([\w-]+)`\s*\|\s*(tier|area|detail)\s*\|/gm
      ),
    ].map((m) => `${m[1]} (${m[2]})`);
    const kind = (tag: string) =>
      (TIER_TAGS as readonly string[]).includes(tag)
        ? "tier"
        : (AREA_TAGS as readonly string[]).includes(tag)
          ? "area"
          : "detail";
    const declared = [...TIER_TAGS, ...AREA_TAGS, ...DETAIL_TAGS].map(
      (t) => `${t} (${kind(t)})`
    );
    expect(rows.sort()).toEqual(declared.sort());
    expect(TAGS.map((t) => t.name).sort()).toEqual(
      [...TIER_TAGS, ...AREA_TAGS, ...DETAIL_TAGS].sort()
    );
  });

  it("lists only legacy paths that still exist", () => {
    const missing = LEGACY_PATHS.filter(
      (f) => !existsSync(path.join(TESTS_DIR, f))
    );
    expect(missing).toEqual([]);
  });
});
