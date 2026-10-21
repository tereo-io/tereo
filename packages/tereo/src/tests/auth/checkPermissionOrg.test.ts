import { ensurePermission, makeServiceOf } from "../utils/testService.js";
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import {
  BASE_URL,
  HTTP_STATUS,
  createTestClient,
  createTestRole,
  createTestUser,
} from "./utils/test-helpers.js";
import {
  ensureTestMembership,
  ensureTestOrganization,
} from "../utils/principals.js";

/**
 * /oauth/check-permission answers a client of an organization about that
 * organization's members only, in it; a service's client about global
 * permissions only; any other client not at all.
 */

type Client = Awaited<ReturnType<typeof createTestClient>>;

let orgClient: Client;
let serviceClient: Client;
let loginClient: Client;
let orgId: string;
let otherOrgId: string;
let permission: string;
let member: string;
let outsider: string;

const check = (
  client: Client,
  body: { user_id: string; organization_id?: string }
) =>
  fetch(`${BASE_URL}/oauth/check-permission`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${Buffer.from(
        `${client.clientId}:${client.plainSecret}`
      ).toString("base64")}`,
    },
    body: JSON.stringify({ ...body, permission }),
  });

const granted = async (res: Response) => {
  expect(res.status).toBe(HTTP_STATUS.OK);
  return ((await res.json()) as { granted: boolean }).granted;
};

beforeAll(async () => {
  orgId = await ensureTestOrganization(`check-perm-org-${Date.now()}`);
  otherOrgId = await ensureTestOrganization(`check-perm-other-${Date.now()}`);
  orgClient = await createTestClient({ clientType: "confidential" });
  await prisma.oAuthClient.update({
    where: { id: orgClient.id },
    data: { organizationId: orgId },
  });
  serviceClient = await createTestClient({ clientType: "confidential" });
  await makeServiceOf(serviceClient.id);
  loginClient = await createTestClient({ clientType: "confidential" });

  // Org roles grant only org-assignable permissions.
  const perm = await ensurePermission("webhooks.read");
  permission = perm.name;
  const role = await createTestRole();
  await prisma.rolePermission.create({
    data: { roleId: role.id, permissionId: perm.id },
  });

  // The member holds the permission in the client's organization only.
  member = (await createTestUser()).id;
  await ensureTestMembership(member, orgId);
  await prisma.userRole.create({
    data: { userId: member, roleId: role.id, organizationId: orgId },
  });
  outsider = (await createTestUser()).id;
  await ensureTestMembership(outsider, otherOrgId);
  await prisma.userRole.create({
    data: { userId: outsider, roleId: role.id },
  });
});

describe("a client of an organization", () => {
  it("is answered about its members, in its organization", async () => {
    expect(await granted(await check(orgClient, { user_id: member }))).toBe(
      true
    );
    expect(
      await granted(
        await check(orgClient, { user_id: member, organization_id: orgId })
      )
    ).toBe(true);
  });

  it("may not name another organization", async () => {
    const res = await check(orgClient, {
      user_id: member,
      organization_id: otherOrgId,
    });
    expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
  });

  it("may not ask about a user outside its organization", async () => {
    const res = await check(orgClient, { user_id: outsider });
    expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
  });

  it("gets the same 403 for a user who does not exist", async () => {
    const res = await check(orgClient, { user_id: crypto.randomUUID() });
    expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
  });
});

describe("a confidential client of no organization and no service", () => {
  it("is refused", async () => {
    const res = await check(loginClient, { user_id: outsider });
    expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
  });

  it("is refused before the user is looked up", async () => {
    const res = await check(loginClient, { user_id: crypto.randomUUID() });
    expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
  });
});

describe("a service's client", () => {
  it("is answered from global roles only", async () => {
    expect(
      await granted(await check(serviceClient, { user_id: outsider }))
    ).toBe(true);
    expect(await granted(await check(serviceClient, { user_id: member }))).toBe(
      false
    );
  });

  it("may not name an organization", async () => {
    const res = await check(serviceClient, {
      user_id: member,
      organization_id: orgId,
    });
    expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
  });
});

describe("a deactivated user or an inactive organization", () => {
  /** A member of a fresh organization holding `permission` globally and in it. */
  const grantedMember = async () => {
    const org = await ensureTestOrganization(`check-perm-live-${Date.now()}`);
    const client = await createTestClient({ clientType: "confidential" });
    await prisma.oAuthClient.update({
      where: { id: client.id },
      data: { organizationId: org },
    });
    const perm = await ensurePermission("webhooks.read");
    const role = await createTestRole();
    await prisma.rolePermission.create({
      data: { roleId: role.id, permissionId: perm.id },
    });
    const user = (await createTestUser()).id;
    await ensureTestMembership(user, org);
    await prisma.userRole.createMany({
      data: [
        { userId: user, roleId: role.id, organizationId: org },
        { userId: user, roleId: role.id },
      ],
    });
    expect(await granted(await check(client, { user_id: user }))).toBe(true);
    expect(await granted(await check(serviceClient, { user_id: user }))).toBe(
      true
    );
    return { org, client, user };
  };

  it("holds nothing once the user is deactivated", async () => {
    const { client, user } = await grantedMember();
    await prisma.user.update({
      where: { id: user },
      data: { isActive: false },
    });
    expect(await granted(await check(client, { user_id: user }))).toBe(false);
    expect(await granted(await check(serviceClient, { user_id: user }))).toBe(
      false
    );
  });

  it("holds nothing in a deactivated organization", async () => {
    const { org, client, user } = await grantedMember();
    await prisma.organization.update({
      where: { id: org },
      data: { isActive: false },
    });
    expect(await granted(await check(client, { user_id: user }))).toBe(false);
  });

  it("holds nothing in an archived organization", async () => {
    const { org, client, user } = await grantedMember();
    await prisma.organization.update({
      where: { id: org },
      data: { isActive: false, archivedAt: new Date() },
    });
    expect(await granted(await check(client, { user_id: user }))).toBe(false);
  });
});
