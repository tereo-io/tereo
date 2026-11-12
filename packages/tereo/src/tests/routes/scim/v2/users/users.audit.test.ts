// @module-tag int
// @module-tag auth
// @module-tag audit
import { DEFAULT_ORGANIZATION_ID } from "../../../../../definitions/index.js";
import { createScimConnection, scimFetch } from "../../../../support/scim.js";
import { createTestRole } from "../../../../support/auth/users.js";
import { oktaCreateUser } from "../../../../fixtures/scim/okta.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import { describe, expect, it } from "vitest";
import {
  makeUser,
  SYSTEM_USER_ID,
  tag,
} from "../../../../support/scimUsers.js";
import {
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../../../../support/webhooks.js";

const body = (email: string) => ({
  ...oktaCreateUser,
  userName: email,
  emails: [{ primary: true, type: "work", value: email }],
});

describe("POST /scim/v2/Users audit", () => {
  it("audits a created user as the system user and emits auth.user.created", async () => {
    const endpoint = await createTestWebhookEndpoint(
      await getCoreEventSubscriberToken(DEFAULT_ORGANIZATION_ID),
      { eventTypes: ["auth.user.created"] }
    );
    const role = await createTestRole();
    const c = await createScimConnection({ roleIds: [role.id] });
    const email = `audit-${tag()}@${c.domain}`;
    const { status, body: created } = await scimFetch(
      c.token,
      "POST",
      "/scim/v2/Users",
      body(email)
    );
    expect(status).toBe(201);

    const entries = await prisma.auditLogEntry.findMany({
      where: { entityName: email },
      orderBy: { createdAt: "asc" },
    });
    expect(entries.every((e) => e.userId === SYSTEM_USER_ID)).toBe(true);
    expect(entries.map((e) => `${e.action} ${e.entityType}`).sort()).toEqual([
      "CREATE OrganizationMember",
      "CREATE User",
      "UPDATE OrganizationMember",
    ]);
    const userEntry = entries.find((e) => e.entityType === "User");
    expect(userEntry?.entityId).toBe(created.id);
    expect(userEntry?.metadata).toMatchObject({
      scimConnectionId: c.connectionId,
      providerId: c.providerId,
    });
    const rolesEntry = entries.find((e) => e.action === "UPDATE");
    expect(rolesEntry?.metadata).toMatchObject({
      action: "roles_changed",
      roleIds: [role.id],
    });
    for (const entry of entries) {
      expect(entry.metadata).toMatchObject({
        scimConnectionId: c.connectionId,
      });
    }

    const where = {
      webhookEndpointId: endpoint.id,
      eventType: "auth.user.created",
      payload: { path: ["entityId"], equals: created.id },
    };
    await waitFor(
      async () => (await prisma.webhookDelivery.count({ where })) > 0,
      10_000
    );
  });

  it("audits an adoption once, as the system user, with the connection", async () => {
    const c = await createScimConnection();
    const user = await makeUser(`adopt-${tag()}@${c.domain}`);
    const { status } = await scimFetch(
      c.token,
      "POST",
      "/scim/v2/Users",
      body(user.email)
    );
    expect(status).toBe(201);
    const entries = await prisma.auditLogEntry.findMany({
      where: {
        entityId: user.id,
        metadata: { path: ["action"], equals: "scim_adopted" },
      },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      userId: SYSTEM_USER_ID,
      action: "UPDATE",
      entityType: "User",
      entityName: user.email,
      metadata: {
        action: "scim_adopted",
        scimConnectionId: c.connectionId,
        providerId: c.providerId,
      },
    });
  });

  it("audits no profile change when the body names what the user already has", async () => {
    const c = await createScimConnection();
    const user = await prisma.user.create({
      data: {
        email: `same-${tag()}@${c.domain}`,
        name: "Jane Doe",
        firstName: "Jane",
        lastName: "Doe",
      },
    });
    const { status } = await scimFetch(
      c.token,
      "POST",
      "/scim/v2/Users",
      body(user.email)
    );
    expect(status).toBe(201);
    const entries = await prisma.auditLogEntry.findMany({
      where: { entityId: user.id },
    });
    expect(entries).toHaveLength(1);
  });
});
