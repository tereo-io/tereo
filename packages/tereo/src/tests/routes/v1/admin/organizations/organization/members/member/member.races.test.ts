// @module-tag int
// @module-tag auth
// @module-tag race

import { getTestPrincipalToken } from "../../../../../../../support/principals.js";
import { prisma } from "../../../../../../../../utils/db/prisma.js";
import { describe, it, expect, beforeAll } from "vitest";
import {
  BASE_URL,
  addTestOrgMember,
  createTestOrganization,
  createTestUser,
  HTTP_STATUS,
  createTestClient,
  createAdminUser,
  getAccessTokenForUser,
} from "../../../../../../../support/auth.js";

const ITERATIONS = 60;

const call = (method: string, path: string, token: string, body?: unknown) =>
  fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined && { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Alternates which side starts late, over a range of offsets. */
const race = <A, B>(i: number, a: () => Promise<A>, b: () => Promise<B>) => {
  const offset = i % 20;
  return Promise.all([
    sleep(i % 2 === 0 ? offset : 0).then(a),
    sleep(i % 2 === 0 ? 0 : offset).then(b),
  ]);
};

let adminToken: string;

beforeAll(async () => {
  adminToken = await getTestPrincipalToken({ permissions: ["admin"] });
});

describe("PATCH and DELETE /v1/v1/admin/organizations/:id/members/:userId", () => {
  const setup = async () => {
    const org = await createTestOrganization(adminToken);
    const owner = await createTestUser();
    await addTestOrgMember(adminToken, org.id, owner.id, "owner");
    const orgAdmin = await createTestUser();
    await addTestOrgMember(adminToken, org.id, orgAdmin.id, "admin");
    const orgAdminToken = await getTestPrincipalToken({
      userId: orgAdmin.id,
      permissions: [],
    });
    const target = await createTestUser();
    return { org, orgAdminToken, target };
  };

  const memberPath = (orgId: string, userId: string) =>
    `/v1/admin/organizations/${orgId}/members/${userId}`;

  it("never changes the tier of someone who is an owner by then", async () => {
    const { org, orgAdminToken, target } = await setup();
    await addTestOrgMember(adminToken, org.id, target.id, "admin");
    const where = {
      organizationId_userId: { organizationId: org.id, userId: target.id },
    };

    let demotedOwner = 0;
    for (let i = 0; i < ITERATIONS; i++) {
      await prisma.organizationMember.update({
        where,
        data: { memberRole: "admin" },
      });
      const [byOrgAdmin, byPlatform] = await race(
        i,
        () =>
          call("PATCH", memberPath(org.id, target.id), orgAdminToken, {
            memberRole: "member",
          }),
        () =>
          call("PATCH", memberPath(org.id, target.id), adminToken, {
            memberRole: "owner",
          })
      );
      const final = await prisma.organizationMember.findUniqueOrThrow({
        where,
      });
      if (
        byOrgAdmin.status === 200 &&
        byPlatform.status === 200 &&
        final.memberRole === "member"
      ) {
        demotedOwner++;
      }
    }
    expect(demotedOwner).toBe(0);
  }, 120_000);

  it("never removes someone who is an owner by then", async () => {
    const { org, orgAdminToken, target } = await setup();

    let removedOwner = 0;
    for (let i = 0; i < ITERATIONS; i++) {
      await prisma.organizationMember.deleteMany({
        where: { organizationId: org.id, userId: target.id },
      });
      await prisma.organizationMember.create({
        data: {
          organizationId: org.id,
          userId: target.id,
          memberRole: "admin",
        },
      });
      const [byOrgAdmin, byPlatform] = await race(
        i,
        () => call("DELETE", memberPath(org.id, target.id), orgAdminToken),
        () =>
          call("PATCH", memberPath(org.id, target.id), adminToken, {
            memberRole: "owner",
          })
      );
      // The promotion found the membership, so it came first: the removal
      // that followed took an owner.
      if (byOrgAdmin.status === 204 && byPlatform.status === 200) {
        removedOwner++;
      }
    }
    expect(removedOwner).toBe(0);
  }, 120_000);
});

describe("DELETE /v1/v1/admin/organizations/:id/members/:userId", () => {
  let adminToken: string;

  beforeAll(async () => {
    const testClient = await createTestClient();
    const adminUser = await createAdminUser();
    adminToken = await getAccessTokenForUser(adminUser, testClient);
  });

  it("two concurrent removals of the last two owners: one is refused", async () => {
    const org = await createTestOrganization(adminToken);
    const owners = [await createTestUser(), await createTestUser()];
    for (const owner of owners) {
      await addTestOrgMember(adminToken, org.id, owner.id, "owner");
    }

    const responses = await Promise.all(
      owners.map((owner) =>
        fetch(
          `${BASE_URL}/v1/admin/organizations/${org.id}/members/${owner.id}`,
          {
            method: "DELETE",
            headers: { Authorization: `Bearer ${adminToken}` },
          }
        )
      )
    );
    expect(responses.map((r) => r.status).sort()).toEqual([
      HTTP_STATUS.NO_CONTENT,
      HTTP_STATUS.CONFLICT,
    ]);
    expect(
      await prisma.organizationMember.count({
        where: { organizationId: org.id, memberRole: "owner" },
      })
    ).toBe(1);
  });
});
