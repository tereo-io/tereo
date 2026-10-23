import { getTestPrincipalToken } from "./principals.js";
import { prisma } from "../../utils/db/prisma.js";
import { randomBytes, randomUUID } from "crypto";
import { TEST_SERVICE } from "./testService.js";
import { CORE_URL } from "./coreUrl.js";
import axios from "axios";

export const BASE_URL = `${CORE_URL}/v1/webhooks`;

// HTTP Status Code Constants for consistent test assertions
export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  ACCEPTED: 202,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
} as const;

// Test entity tracking for cleanup
const testWebhookEndpointIds: string[] = [];
const testEventTypes: string[] = [];

export function generateUniqueId(): string {
  return randomBytes(8).toString("hex");
}

/**
 * A real access token for a test user holding `webhooks.admin`, scoped to
 * `orgId` — webhook routes resolve the organization from the token. `orgId`
 * may be a label ("other-org-1"); see `support/principals.ts`. `null`
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

const coreEventSubscriberId = randomUUID();

/**
 * A token for creating an endpoint subscribed to core's own events. An
 * endpoint is sent only what its creator may read — `users.read` for user
 * events, access to the bucket for file events — so this user holds `admin`.
 */
export function getCoreEventSubscriberToken(
  orgId: string = "00000000-0000-7002-0000-000000000001"
): Promise<string> {
  return getTestPrincipalToken({
    userId: coreEventSubscriberId,
    organizationId: orgId,
    permissions: ["admin"],
  });
}

/**
 * Get test user ID
 */
export function getTestUserId(): string {
  return "00000000-0000-7001-0000-000000000001";
}

/**
 * Get test org ID
 */
export function getTestOrgId(): string {
  return "00000000-0000-7002-0000-000000000001";
}

// =============================================================================
// EVENT TYPE HELPERS
// =============================================================================

export interface EventTypeResponse {
  eventType: string;
  description: string | null;
  source: string;
  createdAt: string;
}

/**
 * An event type owned by the test service, written directly: event types are
 * declared by services, and the API only reads them. `token` is unused, kept
 * so call sites read as before.
 */
export async function createTestEventType(
  _token?: string,
  options: {
    eventType?: string;
    description?: string;
  } = {}
): Promise<EventTypeResponse> {
  const uniqueId = generateUniqueId();
  const eventType = options.eventType || `test.event.${uniqueId}`;

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

// =============================================================================
// WEBHOOK ENDPOINT HELPERS
// =============================================================================

export interface WebhookEndpointResponse {
  id: string;
  organizationId: string;
  url: string;
  description: string | null;
  signingSecret: string;
  status: "ACTIVE" | "PAUSED" | "DISABLED";
  eventTypes: string[];
  customHeaders: Record<string, string> | null;
  archivedAt: string | null;
  previousSecretExpiresAt: string | null;
  hasDeliveries: boolean;
  createdBy: string;
  creator: { id: string; email: string; name: string | null };
  createdAt: string;
  updatedAt: string;
}

export async function createTestWebhookEndpoint(
  token: string,
  options: {
    url?: string;
    description?: string;
    eventTypes?: string[];
  } = {}
): Promise<WebhookEndpointResponse> {
  const uniqueId = generateUniqueId();

  // Ensure at least one event type exists for the endpoint
  let eventTypes = options.eventTypes;
  if (!eventTypes) {
    const et = await createTestEventType(token, {
      eventType: `test.webhook.${uniqueId}`,
    });
    eventTypes = [et.eventType];
  }

  const response = await axios.post<WebhookEndpointResponse>(
    `${BASE_URL}/webhooks`,
    {
      url: options.url || `https://example.com/webhook/${uniqueId}`,
      description: options.description || "Test webhook endpoint",
      eventTypes,
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      validateStatus: () => true,
    }
  );

  if (response.status !== 201) {
    throw new Error(
      `Failed to create test webhook endpoint: ${response.status} ${JSON.stringify(response.data)}`
    );
  }

  testWebhookEndpointIds.push(response.data.id);
  return response.data;
}

// =============================================================================
// EVENT EMISSION HELPERS
// =============================================================================

export interface EmitEventResponse {
  deliveriesCreated: number;
}

export async function emitTestEvent(
  token: string,
  options: {
    organizationId?: string;
    eventType?: string;
    entityType?: string;
    entityId?: string;
    data?: Record<string, unknown>;
  } = {}
): Promise<EmitEventResponse> {
  const uniqueId = generateUniqueId();

  const response = await axios.post<EmitEventResponse>(
    `${BASE_URL}/events`,
    {
      organizationId: options.organizationId || getTestOrgId(),
      eventType: options.eventType || `test.event.${uniqueId}`,
      entityType: options.entityType || "TestEntity",
      entityId: options.entityId || `test-entity-${uniqueId}`,
      data: options.data || { key: "value" },
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      validateStatus: () => true,
    }
  );

  if (response.status !== 202) {
    throw new Error(
      `Failed to emit test event: ${response.status} ${JSON.stringify(response.data)}`
    );
  }

  return response.data;
}

// =============================================================================
// DELIVERY HELPERS
// =============================================================================

export interface WebhookDeliveryResponse {
  id: string;
  webhookEndpointId: string;
  eventType: string;
  payload: Record<string, unknown>;
  status: "PENDING" | "SUCCESS" | "FAILED";
  attempts: number;
  lastAttemptAt: string | null;
  httpStatus: number | null;
  responseBody: string | null;
  errorMessage: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  hasMore: boolean;
  limit: number;
  nextCursor: string | null;
}

// =============================================================================
// CLEANUP FUNCTIONS
// =============================================================================

/**
 * Cleanup test entities created during this test suite
 */
export async function cleanupTestEntities() {
  // Delete in reverse order of dependencies

  // Delete webhook deliveries for tracked endpoints
  if (testWebhookEndpointIds.length > 0) {
    await prisma.webhookDelivery
      .deleteMany({
        where: { webhookEndpointId: { in: testWebhookEndpointIds } },
      })
      .catch(() => {});
  }

  // Delete webhook endpoints
  if (testWebhookEndpointIds.length > 0) {
    await prisma.webhookEndpoint
      .deleteMany({
        where: { id: { in: testWebhookEndpointIds } },
      })
      .catch(() => {});
  }

  // Delete event types
  if (testEventTypes.length > 0) {
    await prisma.eventType
      .deleteMany({
        where: { eventType: { in: testEventTypes } },
      })
      .catch(() => {});
  }

  // Reset tracking arrays
  testWebhookEndpointIds.length = 0;
  testEventTypes.length = 0;
}

/**
 * Global cleanup for all test entities
 * Should only be called in global teardown after all tests complete
 * Cleans up any leftover test entities (e.g., from failed tests)
 *
 * Runs against a dedicated test DB, so we drop ALL webhook deliveries and
 * endpoints — the previous `organizationId: { startsWith: "test-" }` filter
 * predated the UUIDv7 standardization (org ids were string-typed VarChar).
 */
export async function cleanupAllTestEntities() {
  await prisma.webhookDelivery.deleteMany({}).catch(() => {});
  await prisma.webhookEndpoint.deleteMany({}).catch(() => {});

  // Event types are TEXT-typed and shared with seed data; only drop test ones.
  await prisma.eventType
    .deleteMany({
      where: { eventType: { startsWith: "test." } },
    })
    .catch(() => {});
}

/**
 * Wait for a condition to be true
 * Useful for testing eventual consistency
 */
export async function waitFor(
  condition: () => Promise<boolean>,
  timeout: number = 5000,
  interval: number = 100
): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new Error("Timeout waiting for condition");
}
