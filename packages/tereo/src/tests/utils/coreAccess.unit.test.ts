// @module-tag unit
// @module-tag auth
import { hasPermission } from "../../utils/permissions.js";
import { coreScopesOf } from "../../definitions/index.js";
import { describe, it, expect } from "vitest";
import {
  allowsArea,
  effectivePermissions,
  resolveCoreAccess,
  tokenAudience,
  type CoreAccess,
} from "../../utils/coreAccess.js";

const delegated = (...scopes: string[]): CoreAccess => ({
  kind: "delegated",
  scopes: coreScopesOf(scopes),
});

const can = (live: string[], access: CoreAccess, permission: string) =>
  hasPermission(effectivePermissions(live, access), permission);

describe("resolveCoreAccess", () => {
  it("gives core's UI and services full access, whatever their scopes", () => {
    expect(
      resolveCoreAccess({
        clientId: "tereo-ui",
        isServiceClient: false,
        scopes: [],
      })
    ).toEqual({ kind: "full" });
    expect(
      resolveCoreAccess({
        clientId: "svc",
        isServiceClient: true,
        scopes: ["core:files.read"],
      })
    ).toEqual({ kind: "full" });
  });

  it("delegates by core scopes, and gives nothing without them", () => {
    const access = resolveCoreAccess({
      clientId: "third-party",
      isServiceClient: false,
      scopes: ["openid", "core:audit.read"],
    });
    expect(access.kind).toBe("delegated");
    expect(allowsArea(access, "audit")).toBe(true);
    expect(allowsArea(access, "admin")).toBe(false);
    expect(
      resolveCoreAccess({
        clientId: "third-party",
        isServiceClient: false,
        scopes: ["openid", "profile", "email", "offline_access"],
      })
    ).toEqual({ kind: "none" });
  });
});

describe("core:events and core:organizations", () => {
  it("open only their own areas", () => {
    const events = delegated("core:events");
    expect(allowsArea(events, "events")).toBe(true);
    expect(allowsArea(events, "account")).toBe(false);
    const orgs = delegated("core:organizations");
    expect(allowsArea(orgs, "organizations")).toBe(true);
    expect(allowsArea(orgs, "account")).toBe(false);
    expect(allowsArea(orgs, "admin")).toBe(false);
  });

  it("carry no permissions but support access", () => {
    expect(effectivePermissions(["admin"], delegated("core:events"))).toEqual(
      []
    );
    const orgs = delegated("core:organizations");
    expect(can(["admin"], orgs, "organizations.support-access")).toBe(true);
    expect(can(["organizations.admin"], orgs, "organizations.read")).toBe(
      false
    );
    expect(can(["users.read"], orgs, "organizations.support-access")).toBe(
      false
    );
  });
});

describe("effectivePermissions", () => {
  it("is the live permissions for full access, and none without access", () => {
    expect(effectivePermissions(["admin"], { kind: "full" })).toEqual([
      "admin",
    ]);
    expect(effectivePermissions(["admin"], { kind: "none" })).toEqual([]);
  });

  it("is what both the user and the ceiling cover", () => {
    const reads = delegated("core:files.read");
    expect(can(["admin"], reads, "file-service.objects.read")).toBe(true);
    expect(can(["admin"], reads, "file-service.objects.write")).toBe(false);
    expect(can(["admin"], reads, "file-service.admin")).toBe(false);
    expect(can(["admin"], reads, "users.read")).toBe(false);

    const files = delegated("core:files");
    expect(
      can(["file-service.objects.write"], files, "file-service.objects.read")
    ).toBe(true);
    expect(
      can(["file-service.objects.write"], files, "file-service.objects.delete")
    ).toBe(false);
    expect(
      can(["file-service.buckets.read"], files, "file-service.objects.read")
    ).toBe(false);
  });

  it("matches checking the user and the ceiling separately", () => {
    const live = [
      "users.write",
      "roles.admin",
      "services.approve",
      "webhooks.read",
      "clients.admin",
    ];
    const names = [
      "users.read",
      "users.write",
      "users.delete",
      "roles.read",
      "roles.archive",
      "services.read",
      "services.approve",
      "webhooks.read",
      "webhooks.emit",
      "webhooks.event-types.read",
      "clients.write",
      "admin",
    ];
    for (const scopes of [
      ["core:admin"],
      ["core:admin.read"],
      ["core:webhooks.read"],
    ]) {
      const access = delegated(...scopes);
      const ceiling = coreScopesOf(scopes).flatMap((s) => s.ceiling);
      for (const name of names) {
        expect(can(live, access, name), `${scopes} ${name}`).toBe(
          hasPermission(live, name) && hasPermission(ceiling, name)
        );
      }
    }
  });
});

describe("tokenAudience", () => {
  it("adds core when a core scope is granted", () => {
    expect(tokenAudience([], ["openid"])).toEqual([]);
    expect(
      tokenAudience(["reporting-service"], ["openid", "core:account"])
    ).toEqual(["reporting-service", "core"]);
  });
});
