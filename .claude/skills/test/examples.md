# Testing Code Examples

Condensed from the tereo suite (`packages/tereo/src/tests/`), mostly the webhook
endpoints tests.

## Integration Test — `routes/v1/webhooks/webhooks/webhooks.test.ts`

```typescript
// @module-tag int
// @module-tag webhooks
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  getTestAccessToken,
  getTestOrgId,
  createTestEventType,
  createTestWebhookEndpoint,
  cleanupTestEntities,
  generateUniqueId,
  WebhookEndpointResponse,
} from "../../../../support/webhooks.js";

describe("Webhook Endpoint Management", () => {
  let testToken: string;

  beforeAll(async () => {
    testToken = await getTestAccessToken();
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  describe("POST /webhooks", () => {
    it("should create a webhook endpoint with valid data", async () => {
      const et = await createTestEventType(testToken);
      const uniqueId = generateUniqueId();

      const response = await axios.post<WebhookEndpointResponse>(
        `${BASE_URL}/webhooks`,
        {
          url: `https://example.com/webhook/${uniqueId}`,
          description: "A test webhook endpoint",
          eventTypes: [et.eventType],
        },
        {
          headers: {
            Authorization: `Bearer ${testToken}`,
            "Content-Type": "application/json",
          },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.CREATED);
      expect(response.data.status).toBe("ACTIVE");
      expect(response.data.eventTypes).toContain(et.eventType);
      // The organization comes from the token, not the body.
      expect(response.data.organizationId).toBe(getTestOrgId());
      // Full signing secret only on create.
      expect(response.data.signingSecret).not.toContain("...");
    });

    it("should return 400 for missing url", async () => {
      const et = await createTestEventType(testToken);

      const response = await axios.post(
        `${BASE_URL}/webhooks`,
        { description: "Missing url", eventTypes: [et.eventType] },
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("should return 401 without authentication", async () => {
      const response = await axios.post(
        `${BASE_URL}/webhooks`,
        { url: "https://example.com/webhook", eventTypes: ["test.event"] },
        { validateStatus: () => true }
      );

      expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    });

    it("should return 403 without org_id in token", async () => {
      const tokenNoOrg = await getTestAccessToken(undefined, null);

      const response = await axios.post(
        `${BASE_URL}/webhooks`,
        { url: "https://example.com/webhook", eventTypes: ["test.event"] },
        {
          headers: { Authorization: `Bearer ${tokenNoOrg}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
    });
  });
});
```

## Audit Entry and Outbox Fan-Out — `routes/v1/admin/roles/roles.audit.test.ts` (a route's `.audit` file)

```typescript
// @module-tag int
// @module-tag auth
import { getTestPrincipalToken } from "../../../../support/principals.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import axios from "axios";
import { CORE_URL } from "../../../../support/coreUrl.js";
import {
  createTestWebhookEndpoint,
  getTestAccessToken as getWebhooksToken,
  waitFor,
} from "../../../../support/webhooks.js";
import {
  DEFAULT_ORGANIZATION_ID,
  SYSTEM_USER_ID,
} from "../../../../../definitions/index.js";

const adminToken = (perms: string[]) =>
  getTestPrincipalToken({
    organizationId: DEFAULT_ORGANIZATION_ID,
    permissions: perms,
  });

it("records auth's audit entries in the same transaction", async () => {
  const response = await axios.post(
    `${CORE_URL}/v1/admin/roles`,
    { name: `test_role_${randomUUID().slice(0, 8)}`, displayName: "Test" },
    { headers: { Authorization: `Bearer ${await adminToken(["roles.write"])}` } }
  );
  expect(response.status).toBe(201);

  const entry = await prisma.auditLogEntry.findFirst({
    where: { entityId: response.data.id, entityType: "Role" },
  });
  expect(entry).toMatchObject({
    action: "CREATE",
    source: "tereo",
    writerUserId: SYSTEM_USER_ID,
  });
});

it("fans an auth event out to subscribed webhook endpoints", async () => {
  // Auth events are emitted under the default organization.
  const endpoint = await createTestWebhookEndpoint(
    await getWebhooksToken(undefined, DEFAULT_ORGANIZATION_ID),
    { eventTypes: ["auth.role.updated"] }
  );

  const token = await adminToken(["roles.write", "roles.read"]);
  const role = await axios.post(
    `${CORE_URL}/v1/admin/roles`,
    { name: `test_role_${randomUUID().slice(0, 8)}`, displayName: "Before" },
    { headers: { Authorization: `Bearer ${token}` } }
  );
  await axios.patch(
    `${CORE_URL}/v1/admin/roles/${role.data.id}`,
    { displayName: "After" },
    { headers: { Authorization: `Bearer ${token}` } }
  );

  // emitTx → core.outbox → reaper → webhook fan-out creates the delivery.
  await waitFor(
    async () =>
      (await prisma.webhookDelivery.count({
        where: { webhookEndpointId: endpoint.id, eventType: "auth.role.updated" },
      })) > 0,
    10_000
  );
});
```

## Area Helpers — `support/webhooks.ts` (key exports)

```typescript
import { getTestPrincipalToken } from "./principals.js";
import { TEST_SERVICE } from "./testService.js";
import { prisma } from "../../utils/db/prisma.js";
import { randomBytes } from "crypto";
import { CORE_URL } from "./coreUrl.js";

export const BASE_URL = `${CORE_URL}/v1/webhooks`;

export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  ACCEPTED: 202,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  // ...UNAUTHORIZED 401, FORBIDDEN 403, NOT_FOUND 404, CONFLICT 409
} as const;

const testWebhookEndpointIds: string[] = [];
const testEventTypes: string[] = [];

export function generateUniqueId(): string {
  return randomBytes(8).toString("hex");
}

/**
 * A real access token for a test user holding `webhooks.admin`, scoped to
 * `orgId` — webhook routes resolve the organization from the token. `null`
 * gives a token with no organization.
 */
export function getTestAccessToken(
  userId: string = "00000000-0000-7001-0000-000000000001",
  orgId: string | null = "00000000-0000-7002-0000-000000000001"
): Promise<string> {
  return getTestPrincipalToken({
    userId,
    organizationId: orgId,
    permissions: ["webhooks.admin"],
  });
}

/**
 * An event type owned by the test service, written directly: event types are
 * declared by services, and the API only reads them.
 */
export async function createTestEventType(
  _token?: string,
  options: { eventType?: string; description?: string } = {}
) {
  const eventType = options.eventType || `test.event.${generateUniqueId()}`;
  const created = await prisma.eventType.upsert({
    where: { eventType },
    update: { retiredAt: null, missingSince: null },
    create: {
      eventType,
      description: options.description || "Test event type",
      source: TEST_SERVICE.slug,
      serviceId: TEST_SERVICE.id,
    },
  });
  testEventTypes.push(eventType);
  return { ...created, createdAt: created.createdAt.toISOString() };
}

// Delete in reverse dependency order, straight through prisma.
export async function cleanupTestEntities() {
  if (testWebhookEndpointIds.length > 0) {
    await prisma.webhookDelivery
      .deleteMany({ where: { webhookEndpointId: { in: testWebhookEndpointIds } } })
      .catch(() => {});
    await prisma.webhookEndpoint
      .deleteMany({ where: { id: { in: testWebhookEndpointIds } } })
      .catch(() => {});
  }
  if (testEventTypes.length > 0) {
    await prisma.eventType
      .deleteMany({ where: { eventType: { in: testEventTypes } } })
      .catch(() => {});
  }
  testWebhookEndpointIds.length = 0;
  testEventTypes.length = 0;
}

// ...plus createTestWebhookEndpoint, emitTestEvent, waitFor, cleanupAllTestEntities
```

## Principals — `support/principals.ts` (core of it)

```typescript
export interface TestPrincipalOptions {
  /** Existing or fixture user id. Defaults to a new user. */
  userId?: string;
  /** Organization id or label; `null` for a token with no organization. */
  organizationId?: string | null;
  permissions: string[];
}

const mintToken = async (
  options: TestPrincipalOptions & { userId: string }
): Promise<string> => {
  const userId = await ensureTestUser(options.userId);
  const organizationId =
    options.organizationId == null
      ? undefined
      : await ensureTestOrganization(options.organizationId);
  if (options.permissions.length > 0) {
    // A `test-perms-<hash>` role holding exactly these permissions.
    await assignRole(userId, await ensureRole(options.permissions));
  }

  // Signed like any token, and stored, so requireAuth verifies it for real.
  const client = await getTestClient();
  const { token, jti, expiresAt } = generateAccessToken({
    subject: userId,
    clientId: client.clientId,
    scopes: [],
    organizationId,
  });
  await prisma.accessToken.create({
    data: {
      jti,
      clientId: client.id,
      userId,
      organizationId: organizationId ?? null,
      scopes: [],
      expiresAt,
    },
  });
  return token;
};
```

## Test Service — `support/testService.ts`

```typescript
/**
 * Owner of the permissions, roles and event types tests make directly in the
 * database. It never registers a declaration, so nothing it owns is ever
 * marked missing or retired — unlike core.
 */
export const TEST_SERVICE = {
  id: "00000000-0000-7003-0000-000000000001",
  slug: "test-fixtures",
  name: "Test fixtures",
  namespace: "test-fixtures",
} as const;

/** Core's own permission as registered; anything else owned by the test service. */
export const ensurePermission = (name: string, displayName = name) =>
  prisma.permission.upsert({
    where: { name },
    update: CORE_PERMISSIONS.has(name)
      ? {}
      : { serviceId: TEST_SERVICE_ID, missingSince: null, retiredAt: null },
    create: { name, displayName, serviceId: TEST_SERVICE_ID },
  });
```

## Per-File Setup — `setup/setup.ts`

```typescript
import { initializeRedis } from "../../utils/redis.js";
import { resetRateLimits } from "../support/redis.js";
import { prisma } from "../../utils/db/prisma.js";
import { beforeAll, beforeEach } from "vitest";
import { loadKeys } from "../../utils/keys.js";
import env from "../../env.js";

beforeAll(async () => {
  await initializeRedis(env);
  await prisma.$connect();
  // Tests sign tokens in this process; use the keys the server uses.
  await loadKeys();
});

// Earlier tests would otherwise exhaust rate limits or leave idempotency
// claims behind for later ones.
beforeEach(async () => {
  await resetRateLimits();
});
```

## Global Setup — `setup/globalSetup.ts` (condensed)

```typescript
export async function setup() {
  // globalSetup runs in the main vitest process, where the config's `env`
  // option doesn't apply.
  const { loadTestEnv } = await import("./testEnv.js");
  Object.assign(process.env, loadTestEnv());

  // Non-destructive: migrations apply forward and the seed is idempotent.
  run(["prisma", "migrate", "deploy"]);
  run(["tsx", "src/scripts/seed.ts"]);

  await ensureDefaultOrganization();
  await registerCore();
  await seedTestFixtures(); // test service, FIXTURE_USER_IDS, FIXTURE_ORGANIZATION_IDS

  // Mark first-launch setup complete (routes/v1/setup/ resets it around its own cases).
  await prisma.instance.update({
    where: { id: 1 },
    data: { setupCompletedAt: new Date(), setupCompletedBy: owner.id },
  });

  server = createAppServer(Number(process.env.PORT ?? 4001));
  await server.start();
}

export async function teardown() {
  for (const cleanup of [
    files.cleanupAllTestEntities,
    webhooks.cleanupAllTestEntities,
    audit.cleanupAllTestEntities,
    provisioning.cleanupAllTestEntities,
  ]) {
    await cleanup().catch(() => undefined);
  }
  await server?.stop();
}
```

## Vitest Config — `packages/tereo/vitest.config.ts`

```typescript
import { loadTestEnv, loadUnitTestEnv } from "./src/tests/setup/testEnv.js";
import { TAGS } from "./src/tests/setup/tags.js";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    tags: TAGS,
    strictTags: true,
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/tests/**/*.unit.test.ts"],
          env: loadUnitTestEnv(), // unreachable database and Redis
        },
      },
      {
        test: {
          name: "int",
          include: ["src/tests/**/*.test.ts"],
          exclude: ["src/tests/**/*.unit.test.ts"],
          env: loadTestEnv(), // `intEnv()` in the real file tolerates a missing .env
          setupFiles: ["src/tests/setup/setup.ts"],
          globalSetup: ["src/tests/setup/globalSetup.ts"],
          // Serial across files: every file shares one server and database.
          pool: "forks",
          fileParallelism: false,
        },
      },
    ],
  },
});
```

## Unit Test — `utils/errors.unit.test.ts`

`.unit` tests call the function directly: no server, database or Redis, and no `globalSetup`. The SDK's (`packages/tereo-sdk/src/tests/`) follow the same shape with no
database at all.

```typescript
// @module-tag unit
// @module-tag platform
import { NotFoundError, errorHandler } from "../../utils/errors.js";
import { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";

const handle = (err: unknown) => {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  errorHandler(
    err as Error,
    {} as Request,
    res as unknown as Response,
    vi.fn() as NextFunction
  );
  return {
    status: res.status.mock.calls[0][0],
    body: res.json.mock.calls[0][0],
  };
};

describe("errorHandler", () => {
  it("answers an AppError with its status and code", () => {
    expect(handle(new NotFoundError("No such bucket"))).toEqual({
      status: 404,
      body: { error: "not_found", error_description: "No such bucket" },
    });
  });
});
```
