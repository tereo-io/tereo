// @module-tag int
// @module-tag provisioning
// @module-tag slow
import { removeRoles, removeServices } from "../../support/provisioning.js";
import { provisioningJsonSchema } from "../../../cli/provision/index.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { CORE_SERVICE_ID } from "../../../definitions/index.js";
import { generateClientSecret } from "../../../utils/crypto.js";
import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "../../../utils/db/prisma.js";
import { loadTestEnv } from "../../setup/testEnv.js";
import { CORE_URL } from "../../support/coreUrl.js";
import { randomBytes, randomUUID } from "crypto";
import db from "../../../utils/db/index.js";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import path from "path";
import {
  ensureCurrentPartitions,
  partitionName,
  utcDay,
} from "../../../utils/partitions.js";
import {
  ensureTestUser,
  getTestPrincipalToken,
} from "../../support/principals.js";

const packageDir = path.resolve(import.meta.dirname, "../../../..");
const dirs: string[] = [];
const slugs: string[] = [];
const roleNames: string[] = [];

const cli = (args: string[], env: Record<string, string> = {}) =>
  spawnSync("npx", ["tsx", "src/cli/index.ts", ...args], {
    cwd: packageDir,
    encoding: "utf-8",
    env: { ...process.env, ...loadTestEnv(), ...env },
  });

const tempDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tereo-prov-"));
  dirs.push(dir);
  return dir;
};

const writeService = (dir: string) => {
  const slug = `cli-${randomBytes(4).toString("hex")}`;
  slugs.push(slug);
  writeFileSync(
    path.join(dir, `${slug}.json`),
    JSON.stringify({
      version: "1.0.0",
      service: { slug, name: `Service ${slug}`, secretFrom: "CLI_SECRET" },
    })
  );
  return { slug, env: { CLI_SECRET: generateClientSecret().plainSecret } };
};

const serviceExists = async (slug: string) =>
  (await prisma.service.findUnique({ where: { slug } })) !== null;

afterAll(async () => {
  await removeRoles(roleNames);
  await removeServices(slugs);
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("runProvisionCli", () => {
  describe("provisioning CLI", () => {
    it("applies a folder and prints what changed", async () => {
      const dir = tempDir();
      const { slug, env } = writeService(dir);
      const res = cli(["provision", "--path", dir], env);
      expect(res.status, res.stderr).toBe(0);
      expect(JSON.parse(res.stdout).created).toContain(`service:${slug}`);
      expect(await serviceExists(slug)).toBe(true);
    });

    it("--dry-run writes nothing", async () => {
      const dir = tempDir();
      const { slug, env } = writeService(dir);
      const res = cli(["provision", "--path", dir, "--dry-run"], env);
      expect(res.status, res.stderr).toBe(0);
      expect(JSON.parse(res.stdout).created).toContain(`service:${slug}`);
      expect(await serviceExists(slug)).toBe(false);
    });

    it("exits 1 listing every problem", () => {
      const dir = tempDir();
      writeFileSync(path.join(dir, "bad-one.json"), JSON.stringify({ x: 1 }));
      writeFileSync(path.join(dir, "bad-two.json"), JSON.stringify({ y: 2 }));
      const res = cli(["provision", "--path", dir]);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("bad-one.json");
      expect(res.stderr).toContain("bad-two.json");
    });

    it("registers core's declaration before applying, as start does", async () => {
      // A database core's current declaration has not reached yet: a release's
      // Job can run before any of its pods has started.
      const core = await prisma.service.findUniqueOrThrow({
        where: { id: CORE_SERVICE_ID },
      });
      const permission = await prisma.permission.findUniqueOrThrow({
        where: { name: "roles.read" },
      });
      await prisma.service.update({
        where: { id: CORE_SERVICE_ID },
        data: { declarationHash: "0".repeat(64) },
      });
      await prisma.permission.update({
        where: { id: permission.id },
        data: { retiredAt: new Date() },
      });
      try {
        const dir = tempDir();
        const name = `cli-role-${randomBytes(4).toString("hex")}`;
        roleNames.push(name);
        writeFileSync(
          path.join(dir, "roles.json"),
          JSON.stringify({
            version: "1.0.0",
            roles: [{ name, displayName: name, permissions: ["roles.read"] }],
          })
        );
        const res = cli(["provision", "--path", dir]);
        expect(res.status, res.stderr).toBe(0);
        expect(JSON.parse(res.stdout).roles).toContain(`role:${name}`);
        expect(
          (
            await prisma.service.findUniqueOrThrow({
              where: { id: CORE_SERVICE_ID },
            })
          ).declarationHash
        ).toBe(core.declarationHash);
      } finally {
        await prisma.service.update({
          where: { id: CORE_SERVICE_ID },
          data: { declarationHash: core.declarationHash },
        });
        await prisma.permission.update({
          where: { id: permission.id },
          data: { retiredAt: permission.retiredAt },
        });
      }
    });

    it("creates today's audit partition before registering core", async () => {
      const today = partitionName("audit", utcDay());
      const stash = `${today}_cli_stash`;
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "audit"."audit_log_entries" DETACH PARTITION "audit"."${today}"`
      );
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "audit"."${today}" RENAME TO "${stash}"`
      );
      const core = await prisma.service.findUniqueOrThrow({
        where: { id: CORE_SERVICE_ID },
      });
      // Re-registering core's declaration writes an audit entry.
      await prisma.service.update({
        where: { id: CORE_SERVICE_ID },
        data: { declarationHash: null },
      });
      try {
        const dir = tempDir();
        const { env } = writeService(dir);
        const res = cli(["provision", "--path", dir], env);
        expect(res.status, res.stderr).toBe(0);
        const partitions = await db.auditLogEntries.listPartitions();
        expect(partitions.map((p) => p.child)).toContain(today);
      } finally {
        await prisma.service.update({
          where: { id: CORE_SERVICE_ID },
          data: { declarationHash: core.declarationHash },
        });
        await ensureCurrentPartitions();
        await prisma.$executeRawUnsafe(
          `INSERT INTO "audit"."audit_log_entries" SELECT * FROM "audit"."${stash}"`
        );
        await prisma.$executeRawUnsafe(`DROP TABLE "audit"."${stash}"`);
      }
    });

    it("prints the JSON Schema", () => {
      const res = cli(["provisioning-schema"]);
      expect(res.status, res.stderr).toBe(0);
      expect(JSON.parse(res.stdout).properties.version).toBeDefined();
    });

    it("provisioning.schema.json is current", () => {
      const committed = readFileSync(
        path.join(packageDir, "provisioning.schema.json"),
        "utf-8"
      );
      expect(JSON.parse(committed)).toEqual(provisioningJsonSchema());
    });

    it("applies a role change with a holder, and pushes it over Redis to a connected socket", async () => {
      const dir = tempDir();
      const name = `cli-role-${randomBytes(4).toString("hex")}`;
      roleNames.push(name);
      const writeRole = (version: string, permissions: string[]) =>
        writeFileSync(
          path.join(dir, "roles.json"),
          JSON.stringify({
            version,
            roles: [{ name, displayName: name, permissions }],
          })
        );
      writeRole("1.0.0", ["roles.read"]);
      const first = cli(["provision", "--path", dir]);
      expect(first.status, first.stderr).toBe(0);

      const role = await prisma.role.findFirstOrThrow({
        where: { name, serviceId: null },
      });
      const userId = await ensureTestUser(randomUUID());
      await prisma.userRole.create({ data: { userId, roleId: role.id } });
      const token = await getTestPrincipalToken({ userId, permissions: [] });
      const ws = new WebSocket(
        `${CORE_URL.replace(/^http/, "ws")}/ws/?EIO=4&transport=websocket`
      );
      const events: string[] = [];
      const connected = new Promise<void>((resolve, reject) => {
        ws.addEventListener("message", ({ data }) => {
          const packet = String(data);
          if (packet.startsWith("0")) ws.send(`40${JSON.stringify({ token })}`);
          else if (packet === "2") ws.send("3");
          else if (packet.startsWith("40")) resolve();
          else if (packet.startsWith("44")) reject(new Error(packet));
          else if (packet.startsWith("42")) events.push(packet);
        });
      });
      try {
        await connected;
        writeRole("1.0.1", ["roles.read", "roles.write"]);
        const res = cli(["provision", "--path", dir]);
        expect(res.status, res.stderr).toBe(0);
        expect(JSON.parse(res.stdout).roles).toContain(`role:${name}`);
        for (let i = 0; i < 50 && events.length === 0; i++)
          await new Promise((r) => setTimeout(r, 100));
        expect(events.join()).toContain("auth:permissions:changed");
      } finally {
        ws.close();
      }
    });
  });
});
