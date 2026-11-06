// @module-tag unit
// @module-tag auth
import { ROLES, isRequestableCoreRole } from "../../definitions/roles.js";
import { PERMISSION_CATALOG } from "../../definitions/permissions.js";
import { EVENT_TYPES } from "../../definitions/eventTypes.js";
import { describe, expect, it } from "vitest";
import {
  GUEST_CORE_PERMISSIONS,
  isGuestAllowedCorePermission,
} from "../../definitions/guests.js";

describe("guest definitions", () => {
  it("allows exactly the two object permissions, both org-assignable", () => {
    expect([...GUEST_CORE_PERMISSIONS]).toEqual([
      "file-service.objects.read",
      "file-service.objects.write",
    ]);
    for (const name of GUEST_CORE_PERMISSIONS) {
      const def = PERMISSION_CATALOG.find((p) => p.name === name);
      expect(def?.orgAssignable).toBe(true);
    }
    expect(isGuestAllowedCorePermission("file-service.objects.read")).toBe(
      true
    );
    expect(isGuestAllowedCorePermission("file-service.objects.delete")).toBe(
      false
    );
  });

  it("declares global-only guest permissions", () => {
    for (const name of ["users.guests.read", "users.guests.write"]) {
      const def = PERMISSION_CATALOG.find((p) => p.name === name);
      expect(def).toBeDefined();
      expect(def?.orgAssignable).toBeFalsy();
    }
  });

  it("declares guest_inviter as a requestable role", () => {
    expect(isRequestableCoreRole("guest_inviter")).toBe(true);
    expect(ROLES.find((r) => r.name === "guest_inviter")?.permissions).toEqual([
      "users.guests.read",
      "users.guests.write",
    ]);
  });

  it("declares the guest event types with read permissions", () => {
    const expected: Record<string, string> = {
      "auth.guest.invited": "users.guests.read",
      "auth.guest.extended": "users.guests.read",
      "auth.guest.promoted": "users.guests.read",
      "auth.user.password-setup-link-issued": "users.read",
      "auth.user.password-set": "users.read",
      "auth.role.guest-assignable-changed": "roles.read",
    };
    for (const [eventType, readPermission] of Object.entries(expected)) {
      const def = EVENT_TYPES.find((e) => e.eventType === eventType);
      expect(def, eventType).toBeDefined();
      expect(def?.readPermission).toBe(readPermission);
    }
  });
});
