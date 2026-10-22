import { removeServices } from "./provisioning.js";
import { prisma } from "../../utils/db/prisma.js";
import { TEST_SERVICE } from "./testService.js";
import { CORE_URL } from "./coreUrl.js";
import { fetchJson } from "./http.js";
import { randomBytes } from "crypto";
import { expect } from "vitest";

/**
 * Integrations made through the admin API, with permissions granted straight
 * in the database (the admin role routes are tested in integrations/), and
 * event types owned by the test service. `cleanup` removes all of it.
 */

const rand = () => randomBytes(5).toString("hex");

const slugs: string[] = [];
const roleIds: string[] = [];
const permissionNames: string[] = [];
const eventTypes: string[] = [];

export interface TestIntegration {
  id: string;
  slug: string;
  name: string;
  organizationId: string | null;
  accountId: string;
  clientId: string;
  clientSecret: string;
}

export const createIntegration = async (
  adminToken: string,
  organizationId?: string
): Promise<TestIntegration> => {
  const slug = `int-${rand()}`;
  slugs.push(slug);
  const res = await fetchJson(
    "POST",
    `${CORE_URL}/v1/admin/integrations`,
    adminToken,
    { name: `Integration ${slug}`, slug, organizationId }
  );
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return {
    id: res.body.id,
    slug,
    name: res.body.name,
    organizationId: res.body.organizationId,
    accountId: res.body.serviceAccountUserId,
    clientId: res.body.credentials.clientId,
    clientSecret: res.body.credentials.clientSecret,
  };
};

export const integrationToken = async ({
  clientId,
  clientSecret,
}: TestIntegration): Promise<string> => {
  const response = await fetch(`${CORE_URL}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
};

/** Grants `permissions` to the integration: in its organization, or globally. */
export const grant = async (
  integration: TestIntegration,
  permissions: string[]
): Promise<{ roleId: string }> => {
  const found = await prisma.permission.findMany({
    where: { name: { in: permissions } },
    select: { id: true },
  });
  expect(found).toHaveLength(permissions.length);
  const role = await prisma.role.create({
    data: {
      name: `int-role-${rand()}`,
      displayName: "Integration webhook test role",
      rolePermissions: {
        create: found.map((p) => ({ permissionId: p.id })),
      },
    },
  });
  roleIds.push(role.id);
  await prisma.userRole.create({
    data: {
      userId: integration.accountId,
      roleId: role.id,
      organizationId: integration.organizationId,
    },
  });
  return { roleId: role.id };
};

export const revoke = (integration: TestIntegration, roleId: string) =>
  prisma.userRole.deleteMany({
    where: { userId: integration.accountId, roleId },
  });

/** An event type read with a new org-assignable permission. */
export const readableEventType = async (): Promise<{
  eventType: string;
  readPermission: string;
}> => {
  const readPermission = `${TEST_SERVICE.namespace}.int${rand()}.read`;
  permissionNames.push(readPermission);
  await prisma.permission.create({
    data: {
      name: readPermission,
      displayName: readPermission,
      serviceId: TEST_SERVICE.id,
      orgAssignable: true,
    },
  });
  const eventType = `test.integration.${rand()}`;
  eventTypes.push(eventType);
  await prisma.eventType.create({
    data: {
      eventType,
      description: "Integration webhook test event",
      source: TEST_SERVICE.slug,
      serviceId: TEST_SERVICE.id,
      readPermission,
    },
  });
  return { eventType, readPermission };
};

export const cleanup = async () => {
  await removeServices(slugs);
  const endpoints = {
    subscriptions: { some: { eventType: { in: eventTypes } } },
  };
  await prisma.webhookDelivery.deleteMany({
    where: {
      OR: [{ eventType: { in: eventTypes } }, { webhookEndpoint: endpoints }],
    },
  });
  await prisma.webhookEndpoint.deleteMany({ where: endpoints });
  await prisma.webhookEndpointEventType.deleteMany({
    where: { eventType: { in: eventTypes } },
  });
  await prisma.eventType.deleteMany({
    where: { eventType: { in: eventTypes } },
  });
  await prisma.userRole.deleteMany({ where: { roleId: { in: roleIds } } });
  await prisma.rolePermission.deleteMany({
    where: { roleId: { in: roleIds } },
  });
  await prisma.role.deleteMany({ where: { id: { in: roleIds } } });
  await prisma.rolePermission.deleteMany({
    where: { permission: { name: { in: permissionNames } } },
  });
  await prisma.permission.deleteMany({
    where: { name: { in: permissionNames } },
  });
};
