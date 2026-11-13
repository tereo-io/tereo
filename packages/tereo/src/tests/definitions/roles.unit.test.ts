// @module-tag unit
// @module-tag auth
import { ROLES, isRequestableCoreRole } from "../../definitions/roles.js";
import { PERMISSION_CATALOG } from "../../definitions/permissions.js";
import { describe, expect, it } from "vitest";

const permissionsOf = (name: string) =>
  ROLES.find((r) => r.name === name)?.permissions;

describe("core roles", () => {
  it("lets a service request group_resolver, which grants exactly groups.read", () => {
    expect(isRequestableCoreRole("group_resolver")).toBe(true);
    expect(permissionsOf("group_resolver")).toEqual(["groups.read"]);
  });

  it("gives each resolver role one read permission core declares, not org-assignable", () => {
    const resolvers = ROLES.filter((r) => r.name.endsWith("_resolver"));
    expect(resolvers.map((r) => r.name).sort()).toEqual([
      "group_resolver",
      "tenant_resolver",
      "user_resolver",
    ]);
    for (const role of resolvers) {
      expect(role.requestable).toBe(true);
      expect(role.permissions).toHaveLength(1);
      const [permission] = role.permissions;
      expect(permission.endsWith(".read")).toBe(true);
      const declared = PERMISSION_CATALOG.find((p) => p.name === permission);
      expect(declared).toBeDefined();
      expect(declared?.orgAssignable ?? false).toBe(false);
    }
  });

  it("keeps the administrator roles out of a service's reach", () => {
    for (const role of ROLES.filter(
      (r) => r.name === "admin" || r.name.endsWith("_admin")
    )) {
      expect(isRequestableCoreRole(role.name)).toBe(false);
    }
  });
});
