// @module-tag int
// @module-tag provisioning
import { ensureDefaultOrganization } from "../../utils/defaultOrganization.js";
import { retireMissing, registerDeclaration } from "../../utils/registry.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { uploadTestObject, waitFor } from "../support/files.js";
import { TEST_SERVICE_ID } from "../support/testService.js";
import { SYSTEM_USER_ID } from "../../definitions/index.js";
import { prisma } from "../../utils/db/prisma.js";
import { CORE_URL } from "../support/coreUrl.js";
import db from "../../utils/db/index.js";
import { randomBytes } from "crypto";
import FormData from "form-data";
import axios from "axios";
import {
  provisionService,
  declarationFor,
  newSlug,
  provisionDeclared,
} from "../support/provisioning.js";

const ROOT = CORE_URL;

const rand = () => `x${randomBytes(5).toString("hex")}`;

interface Credentials {
  clientId: string;
  clientSecret: string;
}

const fetchToken = async ({ clientId, clientSecret }: Credentials) => {
  const response = await fetch(`${ROOT}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const body = (await response.json()) as { access_token?: string };
  return { status: response.status, token: body.access_token ?? null };
};

const tokenFor = async (service: { credentials: Credentials }) => {
  const { status, token } = await fetchToken(service.credentials);
  expect(status).toBe(200);
  return token!;
};

describe("retireMissing", () => {
  describe("retirement", () => {
    it("retires what a declaration drops after the grace period, and restores it on declaring it again", async () => {
      const slug = newSlug();
      const full = declarationFor(slug);
      await provisionService({ slug, declaration: full });

      const dropped = `${slug}.items.write`;
      await provisionService({
        slug,
        declaration: {
          ...full,
          permissions: full.permissions!.filter((p) => p.name !== dropped),
        },
      });
      const missing = await prisma.permission.findUniqueOrThrow({
        where: { name: dropped },
      });
      expect(missing.missingSince).not.toBeNull();
      expect(missing.retiredAt).toBeNull();

      await retireMissing(new Date(Date.now() + 23 * 60 * 60 * 1000));
      expect(
        (
          await prisma.permission.findUniqueOrThrow({
            where: { name: dropped },
          })
        ).retiredAt
      ).toBeNull();

      await retireMissing(new Date(Date.now() + 25 * 60 * 60 * 1000));
      expect(
        (
          await prisma.permission.findUniqueOrThrow({
            where: { name: dropped },
          })
        ).retiredAt
      ).not.toBeNull();

      await provisionService({ slug, declaration: full });
      const back = await prisma.permission.findUniqueOrThrow({
        where: { name: dropped },
      });
      expect(back.retiredAt).toBeNull();
      expect(back.missingSince).toBeNull();
    });

    it("audits each item it retires and announces a retired bucket", async () => {
      const slug = newSlug();
      const bucketName = `${slug}-files`;
      const full = declarationFor(slug, {
        buckets: [{ bucketName, policy: "private" }],
      });
      await provisionService({ slug, declaration: full });
      const bucket = await prisma.bucket.findFirstOrThrow({
        where: { name: bucketName, deletedAt: null },
      });
      const permission = await prisma.permission.findUniqueOrThrow({
        where: { name: `${slug}.items.write` },
      });
      const eventType = `${slug}.item.created`;
      // Of all organizations and created by core, so it is sent what it subscribes to.
      const { endpoint } = await db.webhookEndpoints.create({
        organizationId: null,
        ownerServiceId: TEST_SERVICE_ID,
        createdBy: SYSTEM_USER_ID,
        url: "https://example.com/retired-buckets",
        eventTypes: ["file-service.bucket.updated"],
      });

      try {
        await provisionService({
          slug,
          declaration: {
            ...full,
            permissions: full.permissions!.filter(
              (p) => p.name !== permission.name
            ),
            buckets: [],
            eventTypes: [],
          },
        });
        await retireMissing(new Date(Date.now() + 25 * 60 * 60 * 1000));

        const entries = await prisma.auditLogEntry.findMany({
          where: {
            action: "ARCHIVE",
            entityId: { in: [permission.id, String(bucket.id), eventType] },
          },
        });
        expect(entries.map((e) => e.entityType).sort()).toEqual([
          "EventType",
          "Permission",
          "bucket",
        ]);
        for (const entry of entries) {
          expect(entry.userId).toBe(SYSTEM_USER_ID);
          expect(entry.metadata).toMatchObject({ reason: "retired" });
        }

        await waitFor(
          async () =>
            (await prisma.webhookDelivery.count({
              where: {
                webhookEndpointId: endpoint.id,
                payload: { path: ["data", "bucketName"], equals: bucketName },
              },
            })) > 0,
          10_000
        );
        const delivery = await prisma.webhookDelivery.findFirstOrThrow({
          where: { webhookEndpointId: endpoint.id },
        });
        expect(delivery.payload).toMatchObject({
          organizationId: null,
          data: { bucketName, retired: true },
        });
      } finally {
        await prisma.webhookDelivery.deleteMany({
          where: { webhookEndpointId: endpoint.id },
        });
        await prisma.webhookEndpoint.delete({ where: { id: endpoint.id } });
      }
    });

    it("makes a retired bucket read-only", async () => {
      const slug = newSlug();
      const bucketName = `${slug}-docs`;
      const access = { roles: ["file_user"] };
      const service = await provisionDeclared(
        { buckets: [{ bucketName, policy: "private" }] },
        { slug, access }
      );
      const token = await tokenFor(service);

      const file = {
        buffer: Buffer.from("hello"),
        filename: "a.txt",
        contentType: "text/plain",
      };
      await uploadTestObject(token, bucketName, "a.txt", file);

      await provisionDeclared({ buckets: [] }, { slug, access });
      await retireMissing(new Date(Date.now() + 25 * 60 * 60 * 1000));

      const form = new FormData();
      form.append("file", file.buffer, {
        filename: "b.txt",
        contentType: "text/plain",
      });
      const upload = await axios.put(
        `${ROOT}/v1/files/buckets/${bucketName}/objects/b.txt`,
        form,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Idempotency-Key": rand(),
            ...form.getHeaders(),
          },
          validateStatus: () => true,
        }
      );
      expect(upload.status).toBe(409);
      expect(upload.data.error ?? upload.data.code).toBe("bucket_retired");

      const download = await fetch(
        `${ROOT}/v1/files/buckets/${bucketName}/objects/a.txt`,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      expect(download.status).toBe(200);
      expect(await download.text()).toBe("hello");
    });
  });
});

describe("registerDeclaration", () => {
  // Core is the only caller in production; a service row of its own keeps
  // these declarations away from core's.
  const actor = { userId: SYSTEM_USER_ID, email: null };

  const created: string[] = [];

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
    (await prisma.permission.findUniqueOrThrow({ where: { name } }))
      .missingSince;

  beforeAll(async () => {
    // Events are written in this process, outside the server.
    await ensureDefaultOrganization();
  });

  afterAll(async () => {
    await prisma.role.deleteMany({ where: { serviceId: { in: created } } });
    await prisma.permission.deleteMany({
      where: { serviceId: { in: created } },
    });
    await prisma.eventType.deleteMany({
      where: { serviceId: { in: created } },
    });
    await prisma.service.deleteMany({ where: { id: { in: created } } });
  });

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

  it(
    "applies concurrent identical declarations once",
    { tags: ["race"] },
    async () => {
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
    }
  );
});
