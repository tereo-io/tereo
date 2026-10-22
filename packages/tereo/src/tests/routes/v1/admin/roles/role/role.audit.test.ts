// @module-tag int
// @module-tag auth

import { getAccessTokenForUser } from "../../../../../support/auth/login.js";
import { generateUniqueId } from "../../../../../support/auth/crypto.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { describe, it, expect, beforeAll } from "vitest";
import {
  BASE_URL,
  HTTP_STATUS,
} from "../../../../../support/auth/constants.js";
import {
  DEFAULT_ORGANIZATION_ID,
  LOGIN_CLIENT,
} from "../../../../../../definitions/index.js";
import {
  createAdminUser,
  createTestRole,
} from "../../../../../support/auth/users.js";
import {
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../../../../../support/webhooks.js";

interface RoleResponse {
  id?: string;
  name?: string;
  displayName?: string;
  description?: string;
  isSystem?: boolean;
  [key: string]: unknown;
}

let testRole: Awaited<ReturnType<typeof createTestRole>>;
let adminToken: string;

beforeAll(async () => {
  const adminUser = await createAdminUser();
  testRole = await createTestRole();
  // Through core's UI: a delegated token could not grant the test
  // service's permissions, which no core scope's ceiling covers.
  adminToken = await getAccessTokenForUser(
    adminUser,
    await prisma.oAuthClient.findUniqueOrThrow({
      where: { clientId: LOGIN_CLIENT.clientId },
    }),
    "openid profile email"
  );
});

describe("POST /v1/admin/roles/:id/duplicate", () => {
  let endpointId: string;

  beforeAll(async () => {
    const endpoint = await createTestWebhookEndpoint(
      await getCoreEventSubscriberToken(DEFAULT_ORGANIZATION_ID),
      { eventTypes: ["auth.role.created"] }
    );
    endpointId = endpoint.id;
  });

  // emitTx → core.outbox → reaper → fan-out creates the delivery.
  const findCreatedEvent = async (roleId: string) => {
    const where = {
      webhookEndpointId: endpointId,
      eventType: "auth.role.created",
      payload: { path: ["entityId"], equals: roleId },
    };
    await waitFor(
      async () => (await prisma.webhookDelivery.count({ where })) > 0,
      10_000
    );
    const delivery = await prisma.webhookDelivery.findFirstOrThrow({
      where,
    });
    return delivery.payload as {
      organizationId: string;
      entityType: string;
      data: Record<string, unknown>;
    };
  };

  it("is emitted when a role is duplicated, naming the source", async () => {
    const uniqueId = generateUniqueId();
    const response = await fetch(
      `${BASE_URL}/v1/admin/roles/${testRole.id}/duplicate`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: `duplicated-event-${uniqueId}` }),
      }
    );
    expect(response.status).toBe(HTTP_STATUS.CREATED);
    const role = (await response.json()) as RoleResponse;

    const payload = await findCreatedEvent(role.id!);
    expect(payload).toMatchObject({
      organizationId: DEFAULT_ORGANIZATION_ID,
      entityType: "Role",
      data: { id: role.id, name: role.name, duplicatedFrom: testRole.id },
    });
  });
});
