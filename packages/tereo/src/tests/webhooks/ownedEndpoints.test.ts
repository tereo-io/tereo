import { ensureDefaultOrganization } from "../../utils/defaultOrganization.js";
import { removeServices } from "../provisioning/utils/test-helpers.js";
import { processWebhookDelivery } from "../../jobs/webhookDelivery.js";
import { applyProvisioning } from "../../utils/provisioning/index.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPinnedDispatcher } from "../../utils/ssrfGuard.js";
import { BASE_URL, HTTP_STATUS } from "./utils/test-helpers.js";
import { generateClientSecret } from "../../utils/crypto.js";
import { createHmac, randomBytes, randomUUID } from "crypto";
import { SYSTEM_USER_ID } from "../../definitions/index.js";
import { prisma } from "../../utils/db/prisma.js";
import { CORE_URL } from "../utils/coreUrl.js";
import db from "../../utils/db/index.js";
import axios from "axios";
import http from "http";
import type {
  LoadedDocument,
  ResolvedService,
} from "../../utils/provisioning/load.js";
import {
  ensureTestMembership,
  ensureTestOrganization,
  getTestPrincipalToken,
} from "../utils/principals.js";

// An endpoint a service's provisioning document subscribes it to: owned by
// the service, created by its account, for every organization unless it lists
// some, and read-only through the API.

const api = axios.create({ validateStatus: () => true });
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const rand = () => randomBytes(5).toString("hex");
const slugs: string[] = [];

interface ServiceDoc extends LoadedDocument {
  service: ResolvedService;
  plainSecret: string;
}

const serviceDoc = (extra: Partial<ResolvedService>): ServiceDoc => {
  const slug = `prov-${rand()}`;
  slugs.push(slug);
  const { plainSecret, hashedSecret } = generateClientSecret();
  return {
    file: `${slug}.json`,
    version: "1.0.0",
    service: {
      slug,
      name: `Service ${slug}`,
      namespace: slug,
      clientId: slug,
      internalHost: null,
      secretEnv: "SERVICE_SECRET",
      secretHash: hashedSecret,
      access: { roles: [], audiences: [] },
      permissions: [],
      systemRoles: [],
      buckets: [],
      eventTypes: [],
      webhooks: [],
      ...extra,
    },
    clients: [],
    roles: [],
    plainSecret,
  };
};

const serviceToken = async (d: ServiceDoc) => {
  const response = await fetch(`${CORE_URL}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${d.service.clientId}:${d.plainSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
};

let receiver: http.Server;
let receiverPort: number;
const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];

let publisher: ServiceDoc;
let subscriber: ServiceDoc;
let eventType: string;
let webhookSecret: string;
let endpointId: string;
let orgA: string;
let orgB: string;
let publisherToken: string;
let adminToken: string;

beforeAll(async () => {
  // Provisioning's events are written in this process, outside the server.
  await ensureDefaultOrganization();
  receiver = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      received.push({
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf-8"),
      });
      res.writeHead(200).end("ok");
    });
  });
  await new Promise<void>((resolve) =>
    receiver.listen(0, "127.0.0.1", resolve)
  );
  receiverPort = (receiver.address() as { port: number }).port;

  publisher = serviceDoc({
    access: { roles: ["webhook_publisher"], audiences: [] },
  });
  const ns = publisher.service.namespace;
  eventType = `${ns}.item.created`;
  Object.assign(publisher.service, {
    permissions: [
      {
        name: `${ns}.items.read`,
        displayName: "Read items",
        description: "",
        orgAssignable: true,
      },
    ],
    systemRoles: [
      {
        name: `${ns}_item_reader`,
        displayName: "Item reader",
        description: "",
        permissions: [`${ns}.items.read`],
      },
    ],
    eventTypes: [
      {
        eventType,
        description: "Item created",
        readPermission: `${ns}.items.read`,
      },
    ],
  });

  webhookSecret = randomBytes(32).toString("hex");
  subscriber = serviceDoc({
    access: {
      roles: [`${publisher.service.slug}/${ns}_item_reader`],
      audiences: [],
    },
    webhooks: [
      {
        key: "items",
        url: `http://127.0.0.1:${receiverPort}/hook`,
        events: [eventType],
        organizations: "all",
        description: "Every organization's items",
        secretEnv: "ITEMS_WEBHOOK_SECRET",
        secretPlain: webhookSecret,
      },
    ],
  });

  await applyProvisioning({ documents: [publisher, subscriber] });
  endpointId = (
    await prisma.webhookEndpoint.findUniqueOrThrow({
      where: { provisioningKey: `${subscriber.service.slug}:items` },
    })
  ).id;

  orgA = await ensureTestOrganization("owned-endpoints-a");
  orgB = await ensureTestOrganization("owned-endpoints-b");
  publisherToken = await serviceToken(publisher);
  adminToken = await getTestPrincipalToken({
    organizationId: orgA,
    permissions: ["webhooks.admin", "services.approve"],
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
  await removeServices(slugs);
});

/** Emits one event as the publisher; the endpoint's deliveries of it. */
const emit = async (organizationId: string) => {
  const entityId = randomUUID();
  const res = await api.post(
    `${BASE_URL}/events`,
    { organizationId, eventType, entityType: "Item", entityId, data: {} },
    { headers: auth(publisherToken) }
  );
  expect(res.status, JSON.stringify(res.data)).toBe(HTTP_STATUS.ACCEPTED);
  return prisma.webhookDelivery.findMany({
    where: {
      webhookEndpointId: endpointId,
      payload: { path: ["entityId"], equals: entityId },
    },
  });
};

/** A delivery to the endpoint written directly, in `status`. */
const storedDelivery = (
  status: "PENDING" | "FAILED" = "PENDING",
  organizationId?: string
) =>
  db.webhookDeliveries
    .create({
      webhookEndpointId: endpointId,
      eventType,
      payload: { id: randomUUID(), organizationId, eventType, data: { n: 1 } },
    })
    .then(async (delivery) => {
      if (status !== "PENDING")
        await prisma.webhookDelivery.updateMany({
          where: { id: delivery.id },
          data: {
            status,
            attempts: 1,
            completedAt: new Date(),
            responseBody: "echo",
          },
        });
      return delivery;
    });

describe("delivery", () => {
  it("delivers an organization's event to an all-organization endpoint", async () => {
    for (const org of [orgA, orgB]) {
      const deliveries = await emit(org);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0].payload).toMatchObject({ organizationId: org });
    }
  });

  it("signs with the provisioned secret", async () => {
    const delivery = await storedDelivery();
    received.length = 0;
    // The worker's real guard refuses loopback; connect to the local receiver.
    await processWebhookDelivery(
      { data: { deliveryId: delivery.id } },
      {
        connectTarget: async () =>
          createPinnedDispatcher([{ address: "127.0.0.1", family: 4 }]),
      }
    );

    expect(received).toHaveLength(1);
    const [{ headers, body }] = received;
    const timestamp = headers["x-webhook-timestamp"] as string;
    const expected = createHmac("sha256", webhookSecret)
      .update(`${timestamp}.${body}`)
      .digest("hex");
    expect(headers["x-webhook-signature"]).toBe(`sha256=${expected}`);
  });
});

describe("internalHost", () => {
  const internalHost = "hooks.internal.test";
  let owner: ServiceDoc;
  let ownedId: string;

  /** Delivers one stored delivery of `id`, recording what connectTarget got. */
  const deliverTo = async (id: string) => {
    const delivery = await db.webhookDeliveries.create({
      webhookEndpointId: id,
      eventType,
      payload: { id: randomUUID(), eventType, data: {} },
    });
    const given: (string | undefined)[] = [];
    received.length = 0;
    await processWebhookDelivery(
      { data: { deliveryId: delivery.id } },
      {
        connectTarget: async (_url, opts) => {
          given.push(opts?.allowPrivateHost);
          return createPinnedDispatcher([{ address: "127.0.0.1", family: 4 }]);
        },
      }
    );
    return given;
  };

  beforeAll(async () => {
    owner = serviceDoc({
      internalHost,
      access: subscriber.service.access,
      webhooks: [
        {
          key: "internal",
          url: `http://${internalHost}:${receiverPort}/hook`,
          events: [eventType],
          organizations: "all",
          description: null,
          secretEnv: "INTERNAL_WEBHOOK_SECRET",
          secretPlain: randomBytes(32).toString("hex"),
        },
      ],
    });
    await applyProvisioning({ documents: [publisher, subscriber, owner] });
    ownedId = (
      await prisma.webhookEndpoint.findUniqueOrThrow({
        where: { provisioningKey: `${owner.service.slug}:internal` },
      })
    ).id;
  });

  it("is stored on the service by apply, and updated by it", async () => {
    const row = () =>
      prisma.service.findUniqueOrThrow({
        where: { slug: owner.service.slug },
      });
    expect((await row()).internalHost).toBe(internalHost);
    const moved = {
      ...owner,
      service: { ...owner.service, internalHost: "10.35.2.2" },
    };
    await applyProvisioning({ documents: [publisher, subscriber, moved] });
    expect((await row()).internalHost).toBe("10.35.2.2");
    await applyProvisioning({ documents: [publisher, subscriber, owner] });
    expect((await row()).internalHost).toBe(internalHost);
  });

  it("is passed to the guard for the owner's endpoint", async () => {
    expect(await deliverTo(ownedId)).toEqual([internalHost]);
    expect(received).toHaveLength(1);
  });

  it("is not passed for another service's endpoint", async () => {
    expect(await deliverTo(endpointId)).toEqual([undefined]);
  });

  it("is not passed for the owner's endpoint unless provisioned", async () => {
    const { endpoint: made } = await db.webhookEndpoints.create({
      organizationId: null,
      ownerServiceId: (
        await prisma.service.findUniqueOrThrow({
          where: { slug: owner.service.slug },
        })
      ).id,
      createdBy: SYSTEM_USER_ID,
      url: `http://${internalHost}:${receiverPort}/hook`,
      eventTypes: [eventType],
    });
    expect(await deliverTo(made.id)).toEqual([undefined]);
  });

  it("is not passed for an integration's endpoint", async () => {
    const slug = `int-${rand()}`;
    slugs.push(slug);
    const integration = await prisma.service.create({
      data: {
        slug,
        name: slug,
        kind: "integration",
        internalHost,
        createdBy: SYSTEM_USER_ID,
      },
    });
    const { endpoint: made } = await db.webhookEndpoints.create({
      organizationId: null,
      ownerServiceId: integration.id,
      createdBy: SYSTEM_USER_ID,
      provisioned: true,
      url: `http://${internalHost}:${receiverPort}/hook`,
      eventTypes: [eventType],
    });
    expect(await deliverTo(made.id)).toEqual([undefined]);
  });

  it("is not passed for an API-made endpoint to the same URL", async () => {
    const { endpoint: made } = await db.webhookEndpoints.create({
      organizationId: orgA,
      createdBy: SYSTEM_USER_ID,
      url: `http://${internalHost}:${receiverPort}/hook`,
      eventTypes: [eventType],
    });
    try {
      expect(await deliverTo(made.id)).toEqual([undefined]);
    } finally {
      await prisma.webhookEndpoint.update({
        where: { id: made.id },
        data: { archivedAt: new Date() },
      });
    }
  });
});

describe("API", () => {
  const url = () => `${BASE_URL}/webhooks/${endpointId}`;

  it("lets webhooks.admin read an all-organization endpoint and its deliveries, retry and test it", async () => {
    const got = await api.get(url(), { headers: auth(adminToken) });
    expect(got.status, JSON.stringify(got.data)).toBe(HTTP_STATUS.OK);
    expect(got.data).toMatchObject({
      id: endpointId,
      organizationId: null,
      provisioned: true,
      ownerService: {
        slug: subscriber.service.slug,
        name: subscriber.service.name,
      },
    });
    expect(got.data.ownerService.id).toEqual(expect.any(String));

    const list = await api.get(`${BASE_URL}/webhooks`, {
      headers: auth(adminToken),
    });
    expect(list.status).toBe(HTTP_STATUS.OK);
    expect(list.data.data.map((e: { id: string }) => e.id)).toContain(
      endpointId
    );

    const failed = await storedDelivery("FAILED");
    const deliveries = await api.get(`${url()}/deliveries`, {
      headers: auth(adminToken),
    });
    expect(deliveries.status).toBe(HTTP_STATUS.OK);
    expect(deliveries.data.data.map((d: { id: string }) => d.id)).toContain(
      failed.id
    );
    const one = await api.get(`${url()}/deliveries/${failed.id}`, {
      headers: auth(adminToken),
    });
    expect(one.status).toBe(HTTP_STATUS.OK);
    const stats = await api.get(`${url()}/stats`, {
      headers: auth(adminToken),
    });
    expect(stats.status).toBe(HTTP_STATUS.OK);

    const retried = await api.post(
      `${url()}/deliveries/${failed.id}/retry`,
      {},
      { headers: auth(adminToken) }
    );
    expect(retried.status, JSON.stringify(retried.data)).toBe(
      HTTP_STATUS.ACCEPTED
    );
    const bulk = await api.post(
      `${url()}/deliveries/retry`,
      {},
      { headers: auth(adminToken) }
    );
    expect(bulk.status, JSON.stringify(bulk.data)).toBe(HTTP_STATUS.ACCEPTED);

    const tested = await api.post(
      `${url()}/test`,
      {},
      { headers: auth(adminToken) }
    );
    expect(tested.status, JSON.stringify(tested.data)).toBe(
      HTTP_STATUS.ACCEPTED
    );
  });

  it("redacts another organization's payloads by what the viewer may read there", async () => {
    // webhooks.admin everywhere; the event's read permission only in org A.
    const userId = randomUUID();
    await ensureTestMembership(userId, orgA);
    const readItems = await prisma.permission.findUniqueOrThrow({
      where: { name: `${publisher.service.namespace}.items.read` },
    });
    const role = await prisma.role.create({
      data: {
        name: `owned-viewer-${userId}`,
        displayName: "Org-scoped item reader",
        rolePermissions: { create: [{ permissionId: readItems.id }] },
      },
    });
    await prisma.userRole.create({
      data: { userId, roleId: role.id, organizationId: orgA },
    });
    const token = await getTestPrincipalToken({
      userId,
      organizationId: orgA,
      permissions: ["webhooks.admin"],
    });

    try {
      const view = async (organizationId: string) => {
        const delivery = await storedDelivery("FAILED", organizationId);
        const res = await api.get(`${url()}/deliveries/${delivery.id}`, {
          headers: auth(token),
        });
        expect(res.status, JSON.stringify(res.data)).toBe(HTTP_STATUS.OK);
        return res.data;
      };
      const own = await view(orgA);
      expect(own.payloadRedacted).toBe(false);
      expect(own.payload).not.toBeNull();
      expect(own.responseBody).toBe("echo");

      const other = await view(orgB);
      expect(other.payloadRedacted).toBe(true);
      expect(other.payload).toBeNull();
      expect(other.responseBody).toBeNull();
    } finally {
      await prisma.userRole.deleteMany({ where: { roleId: role.id } });
      await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
      await prisma.role.delete({ where: { id: role.id } });
    }
  });

  it("hides it from a caller without webhooks.admin", async () => {
    const token = await getTestPrincipalToken({
      organizationId: orgA,
      permissions: ["webhooks.write"],
    });
    const got = await api.get(url(), { headers: auth(token) });
    expect(got.status).toBe(HTTP_STATUS.NOT_FOUND);
    const deliveries = await api.get(`${url()}/deliveries`, {
      headers: auth(token),
    });
    expect(deliveries.status).toBe(HTTP_STATUS.NOT_FOUND);
    const tested = await api.post(
      `${url()}/test`,
      {},
      { headers: auth(token) }
    );
    expect(tested.status).toBe(HTTP_STATUS.NOT_FOUND);

    const list = await api.get(`${BASE_URL}/webhooks`, {
      headers: auth(token),
    });
    expect(list.status).toBe(HTTP_STATUS.OK);
    expect(list.data.data.map((e: { id: string }) => e.id)).not.toContain(
      endpointId
    );
  });

  it("refuses PATCH, DELETE, archive and rotate-secret on a provisioned endpoint with 409 managed_by_provisioning", async () => {
    const attempts = [
      api.patch(
        url(),
        { url: "https://example.com/x" },
        { headers: auth(adminToken) }
      ),
      api.patch(
        url(),
        { status: "PAUSED", description: "x" },
        { headers: auth(adminToken) }
      ),
      api.delete(url(), { headers: auth(adminToken) }),
      api.post(`${url()}/archive`, {}, { headers: auth(adminToken) }),
      api.post(`${url()}/restore`, {}, { headers: auth(adminToken) }),
      api.post(`${url()}/rotate-secret`, {}, { headers: auth(adminToken) }),
      api.post(
        `${url()}/revoke-previous-secret`,
        {},
        {
          headers: auth(adminToken),
        }
      ),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.status, JSON.stringify(res.data)).toBe(HTTP_STATUS.CONFLICT);
      expect(res.data.error).toBe("managed_by_provisioning");
    }
    const row = await prisma.webhookEndpoint.findUniqueOrThrow({
      where: { id: endpointId },
    });
    expect(row.archivedAt).toBeNull();
    expect(row.url).toBe(`http://127.0.0.1:${receiverPort}/hook`);
  });

  it("lets an admin re-enable a disabled provisioned endpoint", async () => {
    await prisma.webhookEndpoint.update({
      where: { id: endpointId },
      data: { status: "DISABLED", consecutiveFailures: 5 },
    });
    const res = await api.patch(
      url(),
      { status: "ACTIVE" },
      { headers: auth(adminToken) }
    );
    expect(res.status, JSON.stringify(res.data)).toBe(HTTP_STATUS.OK);
    expect(res.data.status).toBe("ACTIVE");
    const row = await prisma.webhookEndpoint.findUniqueOrThrow({
      where: { id: endpointId },
    });
    expect(row.status).toBe("ACTIVE");
    expect(row.consecutiveFailures).toBe(0);
  });
});

describe("access", () => {
  // Last: it revokes what the other tests rely on.
  it("does not deliver when the owner cannot read the event", async () => {
    const service = await prisma.service.findUniqueOrThrow({
      where: { slug: subscriber.service.slug },
    });
    const row = await prisma.serviceAccess.findFirstOrThrow({
      where: { serviceId: service.id, kind: "role" },
    });
    const revoked = await api.post(
      `${CORE_URL}/v1/admin/services/${service.id}/access/revoke`,
      { ids: [row.id] },
      { headers: auth(adminToken) }
    );
    expect(revoked.status, JSON.stringify(revoked.data)).toBe(HTTP_STATUS.OK);

    expect(await emit(orgA)).toHaveLength(0);
  });
});
