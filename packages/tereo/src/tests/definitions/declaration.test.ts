// @module-tag int
// @module-tag notifications
import { hasPermission } from "../../utils/permissions.js";
import { prisma } from "../../utils/db/prisma.js";
import { describe, expect, it } from "vitest";

const NOTIFICATION_PERMISSIONS = [
  "notifications.send",
  "notifications.read",
  "notifications.admin",
];

describe("CORE_DECLARATION", () => {
  describe("notification definitions", () => {
    it("registers three global-only permissions", async () => {
      const rows = await prisma.permission.findMany({
        where: { name: { in: NOTIFICATION_PERMISSIONS }, retiredAt: null },
      });
      expect(rows.map((r) => r.name).sort()).toEqual(
        [...NOTIFICATION_PERMISSIONS].sort()
      );
      expect(rows.every((r) => !r.orgAssignable)).toBe(true);
    });

    it("registers notification_sender holding exactly notifications.send", async () => {
      const role = await prisma.role.findFirstOrThrow({
        where: { name: "notification_sender", retiredAt: null },
        include: { rolePermissions: { include: { permission: true } } },
      });
      expect(role.rolePermissions.map((rp) => rp.permission.name)).toEqual([
        "notifications.send",
      ]);
    });

    it("is covered by the admin role", async () => {
      const role = await prisma.role.findFirstOrThrow({
        where: { name: "admin", serviceId: { not: null } },
        include: { rolePermissions: { include: { permission: true } } },
      });
      const held = role.rolePermissions.map((rp) => rp.permission.name);
      for (const name of NOTIFICATION_PERMISSIONS) {
        expect(hasPermission(held, name)).toBe(true);
      }
    });

    it("registers the five event types", async () => {
      const rows = await prisma.eventType.findMany({
        where: { eventType: { startsWith: "notification." } },
      });
      expect(rows.map((r) => r.eventType).sort()).toEqual([
        "notification.connection.created",
        "notification.connection.deleted",
        "notification.connection.updated",
        "notification.failed",
        "notification.sent",
      ]);
    });
  });
});
