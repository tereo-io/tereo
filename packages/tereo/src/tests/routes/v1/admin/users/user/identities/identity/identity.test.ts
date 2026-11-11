// @module-tag int
// @module-tag auth
// @module-tag security
import { getAccessTokenForUser } from "../../../../../../../support/auth/login.js";
import { getTestPrincipalToken } from "../../../../../../../support/principals.js";
import { createTestClient } from "../../../../../../../support/auth/clients.js";
import { SYSTEM_USER_ID } from "../../../../../../../../definitions/index.js";
import { createTestUser } from "../../../../../../../support/auth/users.js";
import { BASE_URL } from "../../../../../../../support/auth/constants.js";
import { prisma } from "../../../../../../../../utils/db/prisma.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";

let providerId: string;
let client: Awaited<ReturnType<typeof createTestClient>>;
let writer: string;

beforeAll(async () => {
  client = await createTestClient();
  writer = await getTestPrincipalToken({
    permissions: ["users.read", "users.write"],
  });
  const provider = await prisma.identityProvider.create({
    data: {
      slug: `unlink-${randomBytes(5).toString("hex")}`,
      displayName: "Unlink",
      kind: "oidc",
      issuer: "https://idp.test",
      clientId: "c",
      clientSecret: "s",
      createdBy: SYSTEM_USER_ID,
    },
  });
  providerId = provider.id;
});

afterAll(async () => {
  await prisma.userIdentity.deleteMany({ where: { providerId } });
  await prisma.identityProvider.delete({ where: { id: providerId } });
});

describe("DELETE /v1/admin/users/:id/identities/:identityId", () => {
  it("ends every session of the user", async () => {
    const user = await createTestUser();
    const identity = await prisma.userIdentity.create({
      data: {
        userId: user.id,
        providerId,
        subject: randomBytes(8).toString("hex"),
      },
    });
    const token = await getAccessTokenForUser(user, client);

    const res = await fetch(
      `${BASE_URL}/v1/admin/users/${user.id}/identities/${identity.id}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${writer}` } }
    );
    expect(res.status).toBe(204);

    const userinfo = await fetch(`${BASE_URL}/oauth/userinfo`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(userinfo.status).toBe(401);
    expect(
      await prisma.refreshToken.count({
        where: { userId: user.id, revokedAt: null },
      })
    ).toBe(0);
    const entry = await prisma.auditLogEntry.findFirst({
      where: {
        entityType: "User",
        entityId: user.id,
        metadata: { path: ["action"], equals: "sessions_revoked" },
      },
    });
    expect(entry).toMatchObject({ action: "UPDATE" });
  });
});
