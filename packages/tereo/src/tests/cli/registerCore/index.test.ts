// @module-tag int
// @module-tag provisioning
// @module-tag slow
import { CORE_SERVICE_ID } from "../../../definitions/index.js";
import { CORE_VERSION } from "../../../utils/version.js";
import { prisma } from "../../../utils/db/prisma.js";
import { loadTestEnv } from "../../setup/testEnv.js";
import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import path from "path";

const packageDir = path.resolve(import.meta.dirname, "../../../..");

const cli = (args: string[]) =>
  spawnSync("npx", ["tsx", "src/cli/index.ts", "register-core", ...args], {
    cwd: packageDir,
    encoding: "utf-8",
    env: { ...process.env, ...loadTestEnv() },
  });

const coreRow = () =>
  prisma.service.findUniqueOrThrow({ where: { id: CORE_SERVICE_ID } });

const permission = () =>
  prisma.permission.findUniqueOrThrow({ where: { name: "roles.read" } });

describe("register-core", () => {
  it("exits 1 with usage on an unknown argument", () => {
    const res = cli(["--accept-oldr"]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("Usage: register-core [--accept-older]");
  });

  it("applies this release's declaration over a newer one only with --accept-older", async () => {
    const core = await coreRow();
    // As a newer release left it: its declaration recorded, and a permission
    // this release still declares dropped and waiting to retire.
    await prisma.service.update({
      where: { id: CORE_SERVICE_ID },
      data: { declarationHash: "0".repeat(64), declarationVersion: "999.0.0" },
    });
    await prisma.permission.update({
      where: { name: "roles.read" },
      data: { missingSince: new Date() },
    });
    try {
      const refused = cli([]);
      expect(refused.status, refused.stderr).toBe(1);
      expect(refused.stderr).toContain("--accept-older");
      expect((await permission()).missingSince).not.toBeNull();
      expect((await coreRow()).declarationVersion).toBe("999.0.0");

      const accepted = cli(["--accept-older"]);
      expect(accepted.status, accepted.stderr).toBe(0);
      expect(JSON.parse(accepted.stdout)).toEqual({
        applied: true,
        changed: true,
        version: CORE_VERSION,
        acceptOlder: true,
      });
      expect((await permission()).missingSince).toBeNull();
      const row = await coreRow();
      expect(row.declarationVersion).toBe(CORE_VERSION);
      expect(row.declarationHash).toBe(core.declarationHash);

      const audit = await prisma.auditLogEntry.findFirstOrThrow({
        where: { entityType: "Service", entityId: CORE_SERVICE_ID },
        orderBy: { createdAt: "desc" },
      });
      expect(audit.metadata).toMatchObject({
        via: "declaration",
        acceptedOlder: true,
        replacedVersion: "999.0.0",
        version: CORE_VERSION,
      });
    } finally {
      await prisma.service.update({
        where: { id: CORE_SERVICE_ID },
        data: {
          declarationHash: core.declarationHash,
          declarationVersion: core.declarationVersion,
        },
      });
      await prisma.permission.update({
        where: { name: "roles.read" },
        data: { missingSince: null },
      });
    }
  });

  it("is a no-op when nothing newer is recorded", async () => {
    const res = cli(["--accept-older"]);
    expect(res.status, res.stderr).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({
      applied: true,
      changed: false,
      version: CORE_VERSION,
      acceptOlder: true,
    });
  });
});
