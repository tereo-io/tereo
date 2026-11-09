// @module-tag unit
// @module-tag auth
import { readdirSync, readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "url";
import path from "path";

// A user's roles come from direct assignments and from their groups. Code
// that reads `user_roles` by itself sees only the first, so every read goes
// through `utils/db/roles.ts`, which merges both; the files below read it
// directly on purpose.
const SRC = fileURLToPath(new URL("../..", import.meta.url));

const ALLOWED: Record<string, string> = {
  "utils/db/roles.ts": "owns the merge of direct and group assignments",
  "utils/db/organizations.ts":
    "getMemberRoles backs the org role editor, which edits direct assignments only",
  "utils/serviceAccess.ts":
    "a service's access is held by its service account, never a group member",
  "utils/integrations.ts":
    "an integration's roles are held by its service account, never a group member",
  "utils/provisioning/apply.ts":
    "revokes guests' tokens; guests are never group members",
  "routes/v1/admin/roles/role/controllers.ts":
    "revokes guests' tokens; guests are never group members",
  "utils/db/services.ts":
    "lists an integration's service account's roles; service accounts are never group members",
  "utils/transformers.ts":
    "formats the integration service account roles that utils/db/services.ts reads",
};

// Model reads, relation filters, nested selects and includes (`userRoles:
// true`, `_count: { select: { userRoles: true } }`), reading a loaded
// relation (`user.userRoles`), and raw SQL naming the table.
const READ = new RegExp(
  [
    String.raw`\.userRole\.(findMany|findFirst|findFirstOrThrow|findUnique|findUniqueOrThrow|count|groupBy|aggregate)\b`,
    String.raw`\buserRoles\s*:\s*(true\b|\{\s*(some|none|every|select|include|where|orderBy|take|skip|cursor|distinct)\b)`,
    String.raw`\.userRoles\b`,
    String.raw`"user_roles"`,
  ].join("|")
);

const files = readdirSync(SRC, { recursive: true, encoding: "utf8" })
  .map((f) => f.split(path.sep).join("/"))
  .filter((f) => f.endsWith(".ts") && !f.startsWith("tests/"));

describe("user role reads", () => {
  it("finds the source files", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it.each([
    "tx.userRole.findMany({ where: { userId } })",
    "db.userRole.count()",
    "where: { userRoles: { some: { roleId } } }",
    "include: { userRoles: true }",
    "select: {\n  userRoles: {\n    select: { roleId: true },\n  },\n}",
    "_count: { select: { userRoles: true } }",
    "account?.userRoles ?? []",
    'tx.$queryRaw`SELECT 1 FROM "auth"."user_roles"`',
  ])("catches %j", (code) => {
    expect(READ.test(code)).toBe(true);
  });

  it.each([
    "await db.userRole.create({ data })",
    "userRoles: { create: [{ roleId }] }",
    "const userRoles = await db.roles.getLiveUserRoles(id, null);",
    'reason: "user_roles_changed"',
  ])("ignores %j", (code) => {
    expect(READ.test(code)).toBe(false);
  });

  it("reads user_roles directly only in the allowlisted files", () => {
    const offending = files.filter(
      (f) =>
        !(f in ALLOWED) && READ.test(readFileSync(path.join(SRC, f), "utf8"))
    );
    expect(offending).toEqual([]);
  });

  it("lists no file that no longer reads user_roles", () => {
    const stale = Object.keys(ALLOWED).filter(
      (f) =>
        !files.includes(f) ||
        !READ.test(readFileSync(path.join(SRC, f), "utf8"))
    );
    expect(stale).toEqual([]);
  });
});
