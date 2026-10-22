import { getTestPrincipalToken } from "../utils/principals.js";
import { InvalidGrantError } from "../../utils/errors.js";
import { handleRefreshToken } from "../../utils/auth.js";
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import { randomBytes } from "node:crypto";
import db from "../../utils/db/index.js";
import {
  BASE_URL,
  HTTP_STATUS,
  createTestClient,
  createTestUser,
  createTestOrganization,
  addTestOrgMember,
} from "./utils/test-helpers.js";

/**
 * A refresh token issued under an organization stops working once the user
 * loses it — deactivated, or their membership removed — including one minted
 * by a refresh racing the deactivation.
 */

let client: Awaited<ReturnType<typeof createTestClient>>;
let clientRecord: Awaited<ReturnType<typeof db.clients.getByClientId>>;
let adminToken: string;

beforeAll(async () => {
  client = await createTestClient();
  clientRecord = await db.clients.getByClientId(client.clientId);
  adminToken = await getTestPrincipalToken({
    permissions: ["organizations.write", "organizations.read"],
  });
});

const setUp = async () => {
  const user = await createTestUser();
  const org = await createTestOrganization(adminToken);
  await addTestOrgMember(adminToken, org.id, user.id);
  const token = randomBytes(32).toString("base64url");
  const id = await db.refreshTokens.create({
    token,
    clientId: clientRecord.id,
    userId: user.id,
    organizationId: org.id,
    scopes: ["openid", "offline_access"],
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  return { user, org, token, id };
};

const refresh = (token: string) =>
  handleRefreshToken(clientRecord, {
    grant_type: "refresh_token",
    client_id: client.clientId,
    refresh_token: token,
  });

const deactivate = (orgId: string) =>
  fetch(`${BASE_URL}/v1/admin/organizations/${orgId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ isActive: false }),
  });

const liveTokens = (organizationId: string) =>
  prisma.refreshToken.count({ where: { organizationId, revokedAt: null } });

describe("refresh tokens of an organization the user lost", () => {
  it("a refresh token for a deactivated organization is refused and revoked", async () => {
    const { org, token, id } = await setUp();
    // Deactivated without the revocation, as if it had missed this token.
    await prisma.organization.update({
      where: { id: org.id },
      data: { isActive: false },
    });

    await expect(refresh(token)).rejects.toThrow(InvalidGrantError);
    const row = await prisma.refreshToken.findUniqueOrThrow({ where: { id } });
    expect(row.revokedAt).not.toBeNull();
  });

  it("a removed member's refresh token is refused", async () => {
    const { user, org, token } = await setUp();
    await prisma.organizationMember.delete({
      where: {
        organizationId_userId: { organizationId: org.id, userId: user.id },
      },
    });

    await expect(refresh(token)).rejects.toThrow(InvalidGrantError);
    expect(await liveTokens(org.id)).toBe(0);
  });

  it("a refresh in flight during deactivation leaves no live token", async () => {
    const { org, token } = await setUp();

    // The deactivation starts while the refresh holds the user's lock, after
    // its membership check passed and before its successor commits.
    let patch: Promise<Response> | undefined;
    const refreshTokens = db.refreshTokens;
    (db as { refreshTokens: typeof refreshTokens }).refreshTokens = {
      ...refreshTokens,
      create: async (...args) => {
        patch = deactivate(org.id);
        await new Promise((resolve) => setTimeout(resolve, 500));
        return refreshTokens.create(...args);
      },
    };
    try {
      await refresh(token);
    } finally {
      (db as { refreshTokens: typeof refreshTokens }).refreshTokens =
        refreshTokens;
    }

    expect((await patch!).status).toBe(HTTP_STATUS.OK);
    expect(await liveTokens(org.id)).toBe(0);
  });
});
