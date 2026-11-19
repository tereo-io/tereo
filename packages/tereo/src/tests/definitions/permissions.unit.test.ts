// @module-tag unit
// @module-tag auth
import { PERMISSION_CATALOG } from "../../definitions/permissions.js";
import { CORE_SCOPES } from "../../definitions/coreScopes.js";
import { hasPermission } from "../../utils/permissions.js";
import { describe, expect, it } from "vitest";

describe("core permissions", () => {
  it.each(["read", "write", "archive", "admin"])(
    "declares groups.%s as not org-assignable",
    (action) => {
      const def = PERMISSION_CATALOG.find((p) => p.name === `groups.${action}`);
      expect(def).toBeDefined();
      expect(def?.orgAssignable).toBe(false);
    }
  );

  it("puts the groups permissions within core:admin and core:admin.read", () => {
    const ceiling = (name: string) =>
      CORE_SCOPES.find((s) => s.name === name)?.ceiling ?? [];
    expect(ceiling("core:admin")).toContain("groups.admin");
    expect(ceiling("core:admin.read")).toContain("groups.read");
  });

  it("declares users.reports.write as not org-assignable", () => {
    const def = PERMISSION_CATALOG.find(
      (p) => p.name === "users.reports.write"
    );
    expect(def).toBeDefined();
    expect(def?.orgAssignable ?? false).toBe(false);
  });

  it("puts users.reports.write within core:admin, not core:admin.read", () => {
    const ceiling = (name: string) =>
      CORE_SCOPES.find((s) => s.name === name)?.ceiling ?? [];
    expect(hasPermission(ceiling("core:admin"), "users.reports.write")).toBe(
      true
    );
    expect(
      hasPermission(ceiling("core:admin.read"), "users.reports.write")
    ).toBe(false);
  });
});
