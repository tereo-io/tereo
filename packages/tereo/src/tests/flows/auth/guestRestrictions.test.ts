// @module-tag int
// @module-tag auth
// @module-tag security
import { createAdminUser, createTestRole } from "../../support/auth/users.js";
import { createTestOrganization } from "../../support/auth/organizations.js";
import { getAccessTokenForUser } from "../../support/auth/login.js";
import { getTestPrincipalToken } from "../../support/principals.js";
import { createTestClient } from "../../support/auth/clients.js";
import { createTestGuest } from "../../support/auth/guests.js";
import { BASE_URL } from "../../support/auth/constants.js";
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../../../utils/db/prisma.js";
import { randomUUID } from "node:crypto";

let adminToken: string;
let org: { id: string };

beforeAll(async () => {
  const client = await createTestClient();
  adminToken = await getAccessTokenForUser(await createAdminUser(), client);
  org = await createTestOrganization(adminToken);
});

const call = (
  method: string,
  path: string,
  body?: unknown,
  token = adminToken
) =>
  fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const expectRefusal = async (res: Response, status: number, error?: string) => {
  expect(res.status).toBe(status);
  if (error)
    expect(((await res.json()) as { error: string }).error).toBe(error);
};

describe("guest restrictions on existing routes", () => {
  it("refuses adding a guest who already belongs to an organization", async () => {
    const { user } = await createTestGuest({ organizationId: org.id });
    const other = await createTestOrganization(adminToken);
    await expectRefusal(
      await call("POST", `/v1/admin/organizations/${other.id}/members`, {
        userId: user.id,
      }),
      400,
      "user_not_addable"
    );
  });

  it("refuses adding a guest with an owner or admin tier", async () => {
    const { user } = await createTestGuest({ organizationId: org.id });
    await prisma.organizationMember.deleteMany({ where: { userId: user.id } });
    const other = await createTestOrganization(adminToken);
    await expectRefusal(
      await call("POST", `/v1/admin/organizations/${other.id}/members`, {
        userId: user.id,
        memberRole: "admin",
      }),
      400,
      "guest_tier"
    );
  });

  it("adds a guest with no organization as a member", async () => {
    const { user } = await createTestGuest({ organizationId: org.id });
    await prisma.organizationMember.deleteMany({ where: { userId: user.id } });
    const other = await createTestOrganization(adminToken);
    const res = await call(
      "POST",
      `/v1/admin/organizations/${other.id}/members`,
      { userId: user.id }
    );
    expect(res.status).toBe(201);
  });

  it("refuses raising a guest's tier", async () => {
    const { user } = await createTestGuest({ organizationId: org.id });
    for (const memberRole of ["admin", "owner"]) {
      await expectRefusal(
        await call(
          "PATCH",
          `/v1/admin/organizations/${org.id}/members/${user.id}`,
          { memberRole }
        ),
        400,
        "guest_tier"
      );
    }
    expect(
      (
        await prisma.organizationMember.findFirstOrThrow({
          where: { userId: user.id },
        })
      ).memberRole
    ).toBe("member");
  });

  it("refuses a global role for a guest", async () => {
    const { user } = await createTestGuest({ organizationId: org.id });
    const role = await createTestRole();
    await expectRefusal(
      await call("PUT", `/v1/admin/users/${user.id}/roles`, {
        roleIds: [role.id],
      }),
      400,
      "guest_global_role"
    );
  });

  it("refuses an organization role that is not guest-assignable, and allows one that is", async () => {
    const { user } = await createTestGuest({ organizationId: org.id });
    const plain = await createTestRole();
    await expectRefusal(
      await call(
        "PUT",
        `/v1/admin/organizations/${org.id}/members/${user.id}/roles`,
        { roleIds: [plain.id] }
      ),
      400,
      "role_not_guest_assignable"
    );

    const allowed = await createTestRole();
    await prisma.role.update({
      where: { id: allowed.id },
      data: { guestAssignable: true },
    });
    const res = await call(
      "PUT",
      `/v1/admin/organizations/${org.id}/members/${user.id}/roles`,
      { roleIds: [allowed.id] }
    );
    expect(res.status).toBe(200);
  });

  it("refuses an identity invite for a guest", async () => {
    const { user } = await createTestGuest({ organizationId: org.id });
    await expectRefusal(
      await call("POST", `/v1/admin/users/${user.id}/identity-invites`, {
        providerId: randomUUID(),
      }),
      400,
      "user_not_invitable"
    );
  });

  it("refuses a guest linking a sign-in provider", async () => {
    const { user } = await createTestGuest({ organizationId: org.id });
    const token = await getTestPrincipalToken({
      userId: user.id,
      organizationId: org.id,
      permissions: [],
      authTime: new Date(),
    });
    const res = await call(
      "POST",
      "/v1/account/identities",
      { provider: "any" },
      token
    );
    expect(res.status).toBe(403);
    expect(
      ((await res.json()) as { error_description: string }).error_description
    ).toContain("Only a person can link");
  });
});
