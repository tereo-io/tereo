// @module-tag int
// @module-tag auth

import { ensureDefaultOrganization } from "../../../../../../utils/defaultOrganization.js";
import { createGroup, setGroupRoles } from "../../../../../../utils/groups.js";
import { ensureTestOrganization } from "../../../../../support/principals.js";
import { getAccessTokenForUser } from "../../../../../support/auth/login.js";
import { generateUniqueId } from "../../../../../support/auth/crypto.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../../../../../utils/db/prisma.js";
import db from "../../../../../../utils/db/index.js";
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
import {
  deleteGroups,
  ensureGroupPermission,
  groupSlug,
  PROVISIONING,
  roleGranting,
} from "../../../../../support/groups.js";

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

describe("DELETE /v1/admin/roles/:id on a role groups hold", () => {
  const groupIds: string[] = [];
  let orgId: string;
  const endpointIds: string[] = [];

  beforeAll(async () => {
    // Events are emitted in-process, under the default organization.
    await ensureDefaultOrganization();
    await ensureGroupPermission();
    orgId = await ensureTestOrganization(`role-delete-${generateUniqueId()}`);
    for (const org of [DEFAULT_ORGANIZATION_ID, orgId]) {
      const endpoint = await createTestWebhookEndpoint(
        await getCoreEventSubscriberToken(org),
        { eventTypes: ["auth.group.roles-changed"] }
      );
      endpointIds.push(endpoint.id);
    }
  });

  afterAll(async () => {
    await deleteGroups(groupIds);
  });

  /** A group holding `roleIds`, made by provisioning so it needs no actor. */
  const groupHolding = async (
    organizationId: string | null,
    roleIds: string[]
  ) => {
    const { group } = await db.$transaction(async (tx) => {
      const made = await createGroup(
        PROVISIONING,
        {
          organizationId,
          slug: groupSlug("role-delete"),
          name: "Role delete group",
          definitionSource: "local",
        },
        tx
      );
      return await setGroupRoles(PROVISIONING, made.group.id, roleIds, tx);
    });
    groupIds.push(group.id);
    return group;
  };

  type Payload = {
    organizationId: string;
    entityType: string;
    data: { removed: string[] } & Record<string, unknown>;
  };

  /** The group's roles-changed deliveries removing a role. */
  const findRemovals = async (groupId: string) => {
    const removals = async () =>
      (
        await prisma.webhookDelivery.findMany({
          where: {
            webhookEndpointId: { in: endpointIds },
            eventType: "auth.group.roles-changed",
            payload: { path: ["entityId"], equals: groupId },
          },
        })
      )
        .map((d) => d.payload as unknown as Payload)
        .filter((p) => p.data.removed.length > 0);
    // emitTx → core.outbox → reaper → fan-out creates the delivery.
    await waitFor(async () => (await removals()).length > 0, 10_000);
    return await removals();
  };

  it("records the role's removal from each group, global and org, as a role change", async () => {
    const role = await roleGranting();
    const kept = await roleGranting();
    const global = await groupHolding(null, [role.id, kept.id]);
    const org = await groupHolding(orgId, [role.id]);

    const response = await fetch(`${BASE_URL}/v1/admin/roles/${role.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(response.status).toBe(HTTP_STATUS.NO_CONTENT);

    const adminUserId = (
      await prisma.auditLogEntry.findFirstOrThrow({
        where: { entityType: "Role", entityId: role.id, action: "DELETE" },
      })
    ).userId;
    for (const [group, organizationId, roleIds] of [
      [global, null, [kept.id]],
      [org, orgId, []],
    ] as const) {
      const entry = await prisma.auditLogEntry.findFirstOrThrow({
        where: { entityType: "Group", entityId: group.id, action: "UPDATE" },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
      expect(entry.userId).toBe(adminUserId);
      expect(entry.organizationId).toBe(organizationId);
      expect(entry.metadata).toEqual({
        action: "roles_changed",
        roleIds,
        added: [],
        removed: [role.id],
        reason: "role_deleted",
      });
      expect(await findRemovals(group.id)).toEqual([
        expect.objectContaining({
          organizationId: organizationId ?? DEFAULT_ORGANIZATION_ID,
          entityType: "Group",
          data: {
            groupId: group.id,
            organizationId,
            roleIds,
            added: [],
            removed: [role.id],
          },
        }),
      ]);
    }
  });
});
