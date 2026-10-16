import { ensureDefaultOrganization } from "../../utils/defaultOrganization.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { registerDeclaration } from "../../utils/registry.js";
import { SYSTEM_USER_ID } from "../../definitions/index.js";
import { prisma } from "../../utils/db/prisma.js";
import { randomBytes } from "crypto";

// Core is the only caller in production; a service row of its own keeps
// these declarations away from core's.
const actor = { userId: SYSTEM_USER_ID, email: null };
const created: string[] = [];

beforeAll(async () => {
  // Events are written in this process, outside the server.
  await ensureDefaultOrganization();
});

afterAll(async () => {
  await prisma.role.deleteMany({ where: { serviceId: { in: created } } });
  await prisma.permission.deleteMany({ where: { serviceId: { in: created } } });
  await prisma.eventType.deleteMany({ where: { serviceId: { in: created } } });
  await prisma.service.deleteMany({ where: { id: { in: created } } });
});

const newService = async () => {
  const slug = `decl-${randomBytes(5).toString("hex")}`;
  const row = await prisma.service.create({
    data: { slug, name: slug, namespace: slug, createdBy: SYSTEM_USER_ID },
  });
  created.push(row.id);
  return { id: row.id, slug, namespace: slug };
};

const declarationFor = (
  ns: string,
  version: string,
  verbs = ["read", "write"]
) => ({
  version,
  permissions: verbs.map((verb) => ({
    name: `${ns}.items.${verb}`,
    displayName: `${verb} items`,
    description: "",
    orgAssignable: false,
  })),
  systemRoles: [],
  buckets: [],
  eventTypes: [],
});

const stored = (id: string) =>
  prisma.service.findUniqueOrThrow({ where: { id } });

const missingSince = async (name: string) =>
  (await prisma.permission.findUniqueOrThrow({ where: { name } })).missingSince;

describe("registerDeclaration", () => {
  it("ignores a declaration older than the one applied", async () => {
    const service = await newService();
    const ns = service.namespace;
    const full = declarationFor(ns, "1.2.0");
    expect(await registerDeclaration(service, full, actor)).toEqual({
      applied: true,
      changed: true,
    });

    // An older release's replica, restarting after the rollout.
    const older = await registerDeclaration(
      service,
      declarationFor(ns, "1.2.0-rc.1", ["read"]),
      actor
    );
    expect(older).toEqual({ applied: false, changed: false });
    expect(await missingSince(`${ns}.items.write`)).toBeNull();

    // The same version applies as before: hash-gated.
    expect(await registerDeclaration(service, full, actor)).toEqual({
      applied: true,
      changed: false,
    });

    // A newer one applies, even with what an older one had dropped.
    const newer = await registerDeclaration(
      service,
      declarationFor(ns, "1.10.0", ["read"]),
      actor
    );
    expect(newer).toEqual({ applied: true, changed: true });
    expect(await missingSince(`${ns}.items.write`)).not.toBeNull();
    expect((await stored(service.id)).declarationVersion).toBe("1.10.0");
  });

  it("moves the version on when only the version changed", async () => {
    const service = await newService();
    const ns = service.namespace;
    await registerDeclaration(service, declarationFor(ns, "1.0.0"), actor);
    const hash = (await stored(service.id)).declarationHash;

    const bumped = await registerDeclaration(
      service,
      declarationFor(ns, "2.0.0"),
      actor
    );
    expect(bumped).toEqual({ applied: true, changed: false });
    expect(await stored(service.id)).toMatchObject({
      declarationVersion: "2.0.0",
      declarationHash: hash,
    });
    expect(
      await registerDeclaration(service, declarationFor(ns, "1.0.0"), actor)
    ).toEqual({ applied: false, changed: false });
  });

  it("applies concurrent identical declarations once", async () => {
    const service = await newService();
    const declaration = declarationFor(service.namespace, "1.0.0");
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        registerDeclaration(service, declaration, actor)
      )
    );
    expect(results.filter((r) => r.changed)).toHaveLength(1);
    expect(results.every((r) => r.applied)).toBe(true);
    expect(
      await prisma.auditLogEntry.count({
        where: { entityId: service.id, entityType: "Service" },
      })
    ).toBe(1);
  });
});
