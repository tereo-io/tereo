// @module-tag int
// @module-tag provisioning
import { CORE_DECLARATION, CORE_SERVICE_ID } from "../../definitions/index.js";
import { declarationHash, declarationSchema } from "../../utils/registry.js";
import { CORE_VERSION } from "../../utils/version.js";
import { prisma } from "../../utils/db/prisma.js";
import { describe, it, expect } from "vitest";

describe("registerCore", () => {
  describe("core", () => {
    it("registers its own declaration on start", async () => {
      const core = await prisma.service.findUniqueOrThrow({
        where: { id: CORE_SERVICE_ID },
      });
      expect(core.declarationHash).toBe(
        declarationHash(declarationSchema.parse(CORE_DECLARATION))
      );
      expect(core.declarationVersion).toBe(CORE_VERSION);
      const admin = await prisma.role.findFirstOrThrow({
        where: { serviceId: CORE_SERVICE_ID, name: "admin" },
      });
      expect(admin.retiredAt).toBeNull();
    });
  });

  describe("org-assignable permissions", () => {
    it("marks core's org-scoped permissions, and only those", async () => {
      const assignable = (
        await prisma.permission.findMany({
          where: { serviceId: CORE_SERVICE_ID, orgAssignable: true },
          select: { name: true },
        })
      ).map((p) => p.name);
      expect(assignable).toContain("file-service.objects.write");
      expect(assignable).toContain("webhooks.write");
      expect(assignable).toContain("audit-logs.read");
      for (const global of [
        "admin",
        "users.read",
        "roles.write",
        "organizations.read",
        "organizations.write",
        "services.approve",
        "settings.write",
        "clients.write",
        "file-service.admin",
        "webhooks.admin",
        "audit-logs.admin",
      ]) {
        expect(assignable).not.toContain(global);
      }
    });
  });
});
