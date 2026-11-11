// @module-tag int
// @module-tag auth
// @module-tag security
import { createTestClient } from "../../../../../support/auth/clients.js";
import { SYSTEM_USER_ID } from "../../../../../../definitions/index.js";
import { createTestUser } from "../../../../../support/auth/users.js";
import { BASE_URL } from "../../../../../support/auth/constants.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { randomBytes } from "node:crypto";
import {
  getAccessTokenForUser,
  getUiAccessTokenForUser,
} from "../../../../../support/auth/login.js";

let providerId: string;
let client: Awaited<ReturnType<typeof createTestClient>>;

beforeAll(async () => {
  client = await createTestClient();
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

const userinfo = (token: string) =>
  fetch(`${BASE_URL}/oauth/userinfo`, {
    headers: { Authorization: `Bearer ${token}` },
  });

describe("DELETE /v1/account/identities/:id", () => {
  it("ends the user's other sessions and keeps the caller's", async () => {
    const user = await createTestUser();
    const identity = await prisma.userIdentity.create({
      data: {
        userId: user.id,
        providerId,
        subject: randomBytes(8).toString("hex"),
      },
    });
    const other = await getAccessTokenForUser(user, client);
    const current = await getUiAccessTokenForUser(user);

    const res = await fetch(
      `${BASE_URL}/v1/account/identities/${identity.id}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${current}` } }
    );
    expect(res.status).toBe(204);

    expect((await userinfo(other)).status).toBe(401);
    expect((await userinfo(current)).status).toBe(200);
    expect(
      await prisma.refreshToken.count({
        where: { userId: user.id, revokedAt: null },
      })
    ).toBe(1);
    const entry = await prisma.auditLogEntry.findFirst({
      where: {
        entityType: "User",
        entityId: user.id,
        metadata: { path: ["action"], equals: "sessions_revoked" },
      },
    });
    expect(entry).toMatchObject({ userId: user.id, action: "LOGOUT" });
  });
});
