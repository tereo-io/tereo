// @module-tag int
// @module-tag auth

import { getAccessTokenForUser } from "../../../../../support/auth/login.js";
import { ensurePermission } from "../../../../../support/testService.js";
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

let adminToken: string;
let endpointId: string;

beforeAll(async () => {
  const adminUser = await createAdminUser();
  adminToken = await getAccessTokenForUser(
    adminUser,
    await prisma.oAuthClient.findUniqueOrThrow({
      where: { clientId: LOGIN_CLIENT.clientId },
    }),
    "openid profile email"
  );
  const endpoint = await createTestWebhookEndpoint(
    await getCoreEventSubscriberToken(DEFAULT_ORGANIZATION_ID),
    { eventTypes: ["auth.role.guest-assignable-changed"] }
  );
  endpointId = endpoint.id;
});

const call = (method: string, path: string, body: unknown) =>
  fetch(`${BASE_URL}/v1/admin/roles${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

const patch = (id: string, body: unknown) => call("PATCH", `/${id}`, body);

const roleWith = async (permissionNames: string[]) => {
  const role = await createTestRole();
  const permissions = await prisma.permission.findMany({
    where: { name: { in: permissionNames } },
  });
  await prisma.rolePermission.createMany({
    data: permissions.map((p) => ({ roleId: role.id, permissionId: p.id })),
  });
  return { role, permissions };
};

const orgAssignablePermission = async () => {
  const name = `test-fixtures.guest${generateUniqueId().replace(/[0-9]/g, "x")}.read`;
  return prisma.permission.update({
    where: { name: (await ensurePermission(name)).name },
    data: { orgAssignable: true },
  });
};

describe("guestAssignable on a custom role", () => {
  it("PATCH guestAssignable on a custom role", async () => {
    const permission = await orgAssignablePermission();
    const { role } = await roleWith([permission.name]);
    const response = await patch(role.id, { guestAssignable: true });
    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(await response.json()).toMatchObject({ guestAssignable: true });

    const audit = await prisma.auditLogEntry.findFirst({
      where: { entityType: "Role", entityId: role.id, action: "UPDATE" },
    });
    expect(audit).not.toBeNull();

    const where = {
      webhookEndpointId: endpointId,
      eventType: "auth.role.guest-assignable-changed",
      payload: { path: ["entityId"], equals: role.id },
    };
    await waitFor(
      async () => (await prisma.webhookDelivery.count({ where })) > 0,
      10_000
    );
  });

  it("is accepted on create", async () => {
    const response = await call("POST", "", {
      name: `guest-create-${generateUniqueId()}`,
      displayName: "Guest create",
      guestAssignable: true,
    });
    expect(response.status).toBe(HTTP_STATUS.CREATED);
    expect(await response.json()).toMatchObject({ guestAssignable: true });
  });

  it("refused on a system role", async () => {
    const role = await createTestRole({ isSystem: true });
    const response = await patch(role.id, { guestAssignable: true });
    expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
  });

  it("refused when a permission is not org-assignable", async () => {
    await ensurePermission("users.read");
    const { role } = await roleWith(["users.read"]);
    const response = await patch(role.id, { guestAssignable: true });
    expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    const body = (await response.json()) as { code?: string; error?: string };
    expect(JSON.stringify(body)).toContain("role_not_guest_assignable");
    expect(JSON.stringify(body)).toContain("users.read");
  });

  it("refused when a core permission is outside the floor", async () => {
    const { role } = await roleWith(["file-service.buckets.read"]);
    const response = await patch(role.id, { guestAssignable: true });
    expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(JSON.stringify(await response.json())).toContain(
      "role_not_guest_assignable"
    );
  });

  it("refused on a provisioned role", async () => {
    const role = await createTestRole();
    await prisma.role.update({
      where: { id: role.id },
      data: { provisioned: true },
    });
    const response = await patch(role.id, { guestAssignable: true });
    expect(response.status).toBe(HTTP_STATUS.CONFLICT);
    expect(JSON.stringify(await response.json())).toContain(
      "managed_by_provisioning"
    );
  });

  it("refuses adding a disallowed permission to a guest-assignable role", async () => {
    const permission = await orgAssignablePermission();
    const { role } = await roleWith([permission.name]);
    expect((await patch(role.id, { guestAssignable: true })).status).toBe(
      HTTP_STATUS.OK
    );
    const bucketsRead = await prisma.permission.findUniqueOrThrow({
      where: { name: "file-service.buckets.read" },
    });
    const response = await call("PUT", `/${role.id}/permissions`, {
      permissionIds: [permission.id, bucketsRead.id],
    });
    expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(JSON.stringify(await response.json())).toContain(
      "role_not_guest_assignable"
    );
  });
});
