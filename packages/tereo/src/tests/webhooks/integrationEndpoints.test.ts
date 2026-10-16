import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import { CORE_URL } from "../utils/coreUrl.js";
import { fetchJson } from "../utils/http.js";
import db from "../../utils/db/index.js";
import { randomUUID } from "crypto";
import {
  cleanup,
  createIntegration,
  grant,
  integrationToken,
  readableEventType,
  revoke,
  type TestIntegration,
} from "./utils/integrations.js";
import {
  ensureTestOrganization,
  getTestPrincipalToken,
} from "../utils/principals.js";

// An integration manages its own webhook endpoints through /v1/webhooks with
// no webhooks.* permission: it sees and changes only the endpoints it owns,
// and each is sent only what the integration itself may read.

const WEBHOOKS = `${CORE_URL}/v1/webhooks/webhooks`;

let adminToken: string;
let emitterToken: string;
let orgA: string;
let orgB: string;
let readable: { eventType: string; readPermission: string };
let unreadable: { eventType: string; readPermission: string };

let a: TestIntegration;
let b: TestIntegration;
let platform: TestIntegration;
let aToken: string;
let bToken: string;
let platformToken: string;
let platformRoleId: string;

let humanToken: string;
let humanEndpointId: string;
let bEndpointId: string;

const call = (
  method: string,
  path: string,
  token: string,
  body?: unknown,
  headers?: Record<string, string>
) => fetchJson(method, `${WEBHOOKS}${path}`, token, body, headers);

const createEndpoint = async (token: string, eventTypes: string[]) => {
  const res = await call("POST", "", token, {
    url: `https://example.com/hooks/${randomUUID()}`,
    eventTypes,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
};

/** A delivery to `endpointId` written directly; its id. */
const storedDelivery = async (
  endpointId: string,
  status: "PENDING" | "FAILED" = "PENDING"
) => {
  const delivery = await db.webhookDeliveries.create({
    webhookEndpointId: endpointId,
    eventType: readable.eventType,
    payload: { id: randomUUID(), organizationId: orgA, data: {} },
  });
  if (status !== "PENDING") {
    await prisma.webhookDelivery.updateMany({
      where: { id: delivery.id },
      data: { status, attempts: 1, completedAt: new Date() },
    });
  }
  return delivery.id;
};

/** Emits one `readable` event in `organizationId`; that event's deliveries per endpoint. */
const emit = async (organizationId: string) => {
  const entityId = randomUUID();
  const res = await fetchJson(
    "POST",
    `${CORE_URL}/v1/webhooks/events`,
    emitterToken,
    {
      organizationId,
      eventType: readable.eventType,
      entityType: "Item",
      entityId,
      data: {},
    }
  );
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  const deliveries = await prisma.webhookDelivery.findMany({
    where: { payload: { path: ["entityId"], equals: entityId } },
    select: { webhookEndpointId: true },
  });
  return deliveries.map((d) => d.webhookEndpointId);
};

beforeAll(async () => {
  adminToken = await getTestPrincipalToken({
    permissions: ["integrations.read", "integrations.write"],
  });
  emitterToken = await getTestPrincipalToken({
    permissions: ["webhooks.admin"],
  });
  orgA = await ensureTestOrganization("integration-endpoints-a");
  orgB = await ensureTestOrganization("integration-endpoints-b");
  readable = await readableEventType();
  unreadable = await readableEventType();

  a = await createIntegration(adminToken, orgA);
  b = await createIntegration(adminToken, orgA);
  platform = await createIntegration(adminToken);
  await grant(a, [readable.readPermission]);
  await grant(b, [readable.readPermission]);
  ({ roleId: platformRoleId } = await grant(platform, [
    readable.readPermission,
  ]));
  aToken = await integrationToken(a);
  bToken = await integrationToken(b);
  platformToken = await integrationToken(platform);

  humanToken = await getTestPrincipalToken({
    organizationId: orgA,
    permissions: ["webhooks.write", readable.readPermission],
  });
  humanEndpointId = (await createEndpoint(humanToken, [readable.eventType])).id;
  bEndpointId = (await createEndpoint(bToken, [readable.eventType])).id;
});

afterAll(async () => {
  await cleanup();
});

describe("creating", () => {
  it("creates an org-bound integration's endpoint in its organization, owned by it", async () => {
    const created = await createEndpoint(aToken, [readable.eventType]);
    expect(created).toMatchObject({
      organizationId: orgA,
      createdBy: a.accountId,
      ownerService: {
        id: a.id,
        slug: a.slug,
        name: a.name,
        kind: "integration",
      },
    });
    expect(created.signingSecret).not.toMatch(/\.\.\.$/);

    const row = await prisma.webhookEndpoint.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(row.ownerServiceId).toBe(a.id);
  });

  it("creates a platform integration's endpoint for every organization", async () => {
    const created = await createEndpoint(platformToken, [readable.eventType]);
    expect(created.organizationId).toBeNull();
    expect(created.ownerService.id).toBe(platform.id);
  });

  it("needs no webhooks.* permission", async () => {
    const permissions = await db.roles.getUserPermissions(
      a.accountId,
      a.organizationId ?? undefined
    );
    expect(permissions.filter((p) => p.startsWith("webhooks."))).toEqual([]);
  });

  it("refuses an event type the integration may not read", async () => {
    const res = await call("POST", "", aToken, {
      url: "https://example.com/hooks/unreadable",
      eventTypes: [unreadable.eventType],
    });
    expect(res.status).toBe(403);

    const own = await createEndpoint(aToken, [readable.eventType]);
    const patched = await call("PATCH", `/${own.id}`, aToken, {
      eventTypes: [unreadable.eventType],
    });
    expect(patched.status).toBe(403);
  });

  it("refuses a private address", async () => {
    const res = await call("POST", "", aToken, {
      url: "http://127.0.0.1:9/hook",
      eventTypes: [readable.eventType],
    });
    expect(res.status).toBe(400);
  });
});

describe("isolation", () => {
  it("lists only the integration's own endpoints", async () => {
    const own = await createEndpoint(aToken, [readable.eventType]);
    const res = await call("GET", "?limit=100", aToken);
    expect(res.status).toBe(200);
    const ids = res.body.data.map((e: { id: string }) => e.id);
    expect(ids).toContain(own.id);
    expect(ids).not.toContain(bEndpointId);
    expect(ids).not.toContain(humanEndpointId);
    for (const endpoint of res.body.data) {
      expect(endpoint.ownerService.id).toBe(a.id);
    }
  });

  it("ignores X-Organization-ID", async () => {
    const res = await call("GET", "?limit=100", aToken, undefined, {
      "X-Organization-ID": orgB,
    });
    expect(res.status).toBe(200);
    for (const endpoint of res.body.data) {
      expect(endpoint.ownerService.id).toBe(a.id);
    }
  });

  it("can't see or change another integration's endpoint, nor its organization's", async () => {
    for (const id of [bEndpointId, humanEndpointId]) {
      const delivery = await storedDelivery(id);
      const attempts: [string, string, unknown?][] = [
        ["GET", `/${id}`],
        ["GET", `/${id}/deliveries/${delivery}`],
        ["POST", `/${id}/deliveries/${delivery}/retry`],
        ["PATCH", `/${id}`, { description: "mine now" }],
        ["DELETE", `/${id}`],
        ["GET", `/${id}/deliveries`],
        ["GET", `/${id}/stats`],
        ["POST", `/${id}/rotate-secret`],
        ["POST", `/${id}/revoke-previous-secret`],
        ["POST", `/${id}/test`],
        ["POST", `/${id}/archive`],
        ["POST", `/${id}/restore`],
        ["POST", `/${id}/deliveries/retry`, {}],
      ];
      for (const [method, path, body] of attempts) {
        const res = await call(method, path, aToken, body);
        expect(res.status, `${method} ${path}`).toBe(404);
      }
    }
    const untouched = await prisma.webhookEndpoint.findUniqueOrThrow({
      where: { id: bEndpointId },
    });
    expect(untouched.description).not.toBe("mine now");
  });

  it("hides an integration's endpoint from organization users without webhooks.admin", async () => {
    const own = await createEndpoint(aToken, [readable.eventType]);
    const member = await getTestPrincipalToken({
      organizationId: orgA,
      permissions: [
        "webhooks.write",
        "webhooks.delete",
        readable.readPermission,
      ],
    });
    for (const token of [humanToken, member]) {
      const list = await call("GET", "?limit=100", token);
      expect(list.status).toBe(200);
      const ids = list.body.data.map((e: { id: string }) => e.id);
      expect(ids).toContain(humanEndpointId);
      expect(ids).not.toContain(own.id);

      const attempts: [string, string, unknown?][] = [
        ["GET", `/${own.id}`],
        ["PATCH", `/${own.id}`, { url: "https://example.com/stolen" }],
        ["PATCH", `/${own.id}`, { status: "PAUSED" }],
        ["GET", `/${own.id}/stats`],
        ["GET", `/${own.id}/deliveries`],
        ["POST", `/${own.id}/test`],
      ];
      // humanToken lacks webhooks.archive/delete: refused before any lookup.
      if (token === member) {
        attempts.push(["POST", `/${own.id}/archive`], ["DELETE", `/${own.id}`]);
      }
      for (const [method, path, body] of attempts) {
        const res = await call(method, path, token, body);
        expect(res.status, `${method} ${path}`).toBe(404);
      }
    }
    const untouched = await prisma.webhookEndpoint.findUniqueOrThrow({
      where: { id: own.id },
    });
    expect(untouched).toMatchObject({ url: own.url, status: "ACTIVE" });
  });

  it("lets webhooks.admin see, pause, archive and delete it, but not change it", async () => {
    const own = await createEndpoint(aToken, [readable.eventType]);
    const id = own.id;
    const delivery = await storedDelivery(id, "FAILED");
    const admin = await getTestPrincipalToken({
      organizationId: orgA,
      permissions: ["webhooks.admin"],
    });

    const list = await call("GET", "?limit=100", admin);
    expect(list.body.data.map((e: { id: string }) => e.id)).toContain(id);
    expect((await call("GET", `/${id}`, admin)).status).toBe(200);
    expect((await call("GET", `/${id}/stats`, admin)).status).toBe(200);
    expect((await call("GET", `/${id}/deliveries`, admin)).status).toBe(200);
    expect(
      (await call("GET", `/${id}/deliveries/${delivery}`, admin)).status
    ).toBe(200);

    const refused: [string, string, unknown?][] = [
      ["PATCH", `/${id}`, { url: "https://example.com/stolen" }],
      ["PATCH", `/${id}`, { status: "PAUSED", description: "x" }],
      ["POST", `/${id}/rotate-secret`],
      ["POST", `/${id}/revoke-previous-secret`],
      ["POST", `/${id}/test`],
      ["POST", `/${id}/deliveries/retry`, {}],
      ["POST", `/${id}/deliveries/${delivery}/retry`],
    ];
    for (const [method, path, body] of refused) {
      const res = await call(method, path, admin, body);
      expect(res.status, `${method} ${path}`).toBe(409);
      expect(res.body.error).toBe("managed_by_integration");
    }

    const paused = await call("PATCH", `/${id}`, admin, { status: "PAUSED" });
    expect(paused.status).toBe(200);
    expect(paused.body).toMatchObject({ status: "PAUSED", url: own.url });
    expect((await call("POST", `/${id}/archive`, admin)).status).toBe(200);
    expect((await call("POST", `/${id}/restore`, admin)).status).toBe(200);
    await prisma.webhookDelivery.deleteMany({
      where: { webhookEndpointId: id },
    });
    expect((await call("DELETE", `/${id}`, admin)).status).toBe(204);
  });
});

describe("managing its own", () => {
  it("rotates, tests, reads deliveries and stats, archives, restores and deletes", async () => {
    const own = await createEndpoint(aToken, [readable.eventType]);
    const id = own.id;

    const rotated = await call("POST", `/${id}/rotate-secret`, aToken);
    expect(rotated.status).toBe(200);
    expect(rotated.body.signingSecret).not.toBe(own.signingSecret);
    expect(
      (await call("POST", `/${id}/revoke-previous-secret`, aToken)).status
    ).toBe(200);

    const patched = await call("PATCH", `/${id}`, aToken, {
      description: "Renamed",
    });
    expect(patched.status).toBe(200);
    expect(patched.body.description).toBe("Renamed");

    expect((await call("POST", `/${id}/test`, aToken)).status).toBe(202);
    const deliveries = await call("GET", `/${id}/deliveries`, aToken);
    expect(deliveries.status).toBe(200);
    expect(deliveries.body.data).toHaveLength(1);
    expect(deliveries.body.data[0].payloadRedacted).toBe(false);
    const delivery = await call(
      "GET",
      `/${id}/deliveries/${deliveries.body.data[0].id}`,
      aToken
    );
    expect(delivery.status).toBe(200);
    expect((await call("GET", `/${id}/stats`, aToken)).status).toBe(200);

    expect((await call("POST", `/${id}/archive`, aToken)).status).toBe(200);
    expect((await call("POST", `/${id}/restore`, aToken)).status).toBe(200);

    await prisma.webhookDelivery.deleteMany({
      where: { webhookEndpointId: id },
    });
    expect((await call("DELETE", `/${id}`, aToken)).status).toBe(204);
  });

  it("lets a platform integration manage its endpoint without an organization", async () => {
    const own = await createEndpoint(platformToken, [readable.eventType]);
    const list = await call("GET", "", platformToken);
    expect(list.status).toBe(200);
    expect(list.body.data.map((e: { id: string }) => e.id)).toContain(own.id);
    expect((await call("GET", `/${own.id}`, platformToken)).status).toBe(200);
    expect((await call("POST", `/${own.id}/test`, platformToken)).status).toBe(
      202
    );
    const deliveries = await call(
      "GET",
      `/${own.id}/deliveries`,
      platformToken
    );
    expect(deliveries.status).toBe(200);
    expect(deliveries.body.data[0].payloadRedacted).toBe(false);
    expect((await call("GET", `/${own.id}/stats`, platformToken)).status).toBe(
      200
    );
  });
});

describe("delivery", () => {
  it("sends a platform integration's endpoint every organization's events it may read", async () => {
    const own = await createEndpoint(platformToken, [readable.eventType]);
    expect(await emit(orgA)).toContain(own.id);
    expect(await emit(orgB)).toContain(own.id);

    await revoke(platform, platformRoleId);
    try {
      expect(await emit(orgA)).not.toContain(own.id);
      expect(await emit(orgB)).not.toContain(own.id);
    } finally {
      ({ roleId: platformRoleId } = await grant(platform, [
        readable.readPermission,
      ]));
    }
  });

  it("sends an org-bound integration's endpoint only its organization's events", async () => {
    const own = await createEndpoint(aToken, [readable.eventType]);
    expect(await emit(orgA)).toContain(own.id);
    expect(await emit(orgB)).not.toContain(own.id);
  });

  it("sends a deactivated integration nothing new", async () => {
    const gone = await createIntegration(adminToken, orgA);
    await grant(gone, [readable.readPermission]);
    const own = await createEndpoint(await integrationToken(gone), [
      readable.eventType,
    ]);
    expect(await emit(orgA)).toContain(own.id);

    const off = await fetchJson(
      "PATCH",
      `${CORE_URL}/v1/admin/integrations/${gone.id}`,
      adminToken,
      { isActive: false }
    );
    expect(off.status).toBe(200);
    expect(await emit(orgA)).not.toContain(own.id);
  });
});
