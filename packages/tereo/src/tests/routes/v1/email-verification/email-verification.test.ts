// @module-tag int
// @module-tag auth
import { ensureDefaultOrganization } from "../../../../utils/defaultOrganization.js";
import { loginAndExchange, postForm } from "../../../support/auth/login.js";
import { BASE_URL, HTTP_STATUS } from "../../../support/auth/constants.js";
import { createTestClient } from "../../../support/auth/clients.js";
import { markEmailVerified } from "../../../../utils/userLinks.js";
import { SYSTEM_USER_ID } from "../../../../definitions/index.js";
import { createTestUser } from "../../../support/auth/users.js";
import { hashFlowToken } from "../../../../utils/crypto.js";
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../../../../utils/db/prisma.js";
import { randomBytes } from "node:crypto";
import axios from "axios";

const REDIRECT_URI = "http://localhost:3000/callback";
const SCOPE = "openid offline_access";

const post = (path: string, body: unknown) =>
  axios.post(`${BASE_URL}/v1/email-verification${path}`, body, {
    validateStatus: () => true,
  });
const inspect = (token: string) => post("/inspect", { token });
const verify = (token: string) => post("", { token });

const insertLink = async (
  userId: string,
  email: string,
  over: { usedAt?: Date; expiresAt?: Date } = {}
) => {
  const token = randomBytes(32).toString("base64url");
  await prisma.userLinkToken.create({
    data: {
      userId,
      purpose: "verify",
      email,
      tokenHash: hashFlowToken(token),
      createdBy: SYSTEM_USER_ID,
      expiresAt: over.expiresAt ?? new Date(Date.now() + 3_600_000),
      usedAt: over.usedAt,
    },
  });
  return token;
};

const unverified = async () => {
  const user = await createTestUser({ emailVerified: false });
  return { user, token: await insertLink(user.id, user.email) };
};

describe("email verification links", () => {
  let client: Awaited<ReturnType<typeof createTestClient>>;

  beforeAll(async () => {
    await ensureDefaultOrganization();
    client = await createTestClient({ redirectUris: [REDIRECT_URI] });
  });

  it("inspect shows the address", async () => {
    const { user, token } = await unverified();
    const { expiresAt } = await prisma.userLinkToken.findFirstOrThrow({
      where: { userId: user.id },
    });

    for (let i = 0; i < 2; i++) {
      const res = await inspect(token);
      expect(res.status).toBe(HTTP_STATUS.OK);
      expect(res.data).toEqual({
        email: user.email,
        expiresAt: expiresAt.toISOString(),
      });
    }
  });

  it("confirm verifies and ends no sessions", async () => {
    const { user, token } = await unverified();
    const before = await loginAndExchange(client, user, REDIRECT_URI, SCOPE);

    expect((await verify(token)).status).toBe(HTTP_STATUS.NO_CONTENT);

    const after = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(after.emailVerifiedAt).not.toBeNull();
    const refreshed = await postForm("/oauth/token", {
      grant_type: "refresh_token",
      client_id: client.clientId,
      refresh_token: before.refresh_token,
    });
    expect(refreshed.status).toBe(HTTP_STATUS.OK);
    expect(
      await prisma.auditLogEntry.count({
        where: {
          entityId: user.id,
          metadata: { path: ["action"], equals: "email_verified" },
        },
      })
    ).toBe(1);
  });

  it("used, expired, unknown → 404", async () => {
    const user = await createTestUser({ emailVerified: false });
    const used = await insertLink(user.id, user.email, { usedAt: new Date() });
    const expired = await insertLink(user.id, user.email, {
      expiresAt: new Date(Date.now() - 1000),
    });
    const unknown = randomBytes(32).toString("base64url");

    for (const token of [used, expired, unknown]) {
      for (const call of [inspect, verify]) {
        const res = await call(token);
        expect(res.status).toBe(HTTP_STATUS.NOT_FOUND);
        expect(res.data.error_description ?? res.data.message).toBe(
          "Not found"
        );
      }
    }
    const after = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(after.emailVerifiedAt).toBeNull();
  });

  it("a link for an old address is 404", async () => {
    const { user, token } = await unverified();
    await prisma.user.update({
      where: { id: user.id },
      data: { email: `moved-${randomBytes(4).toString("hex")}@test.local` },
    });

    expect((await inspect(token)).status).toBe(HTTP_STATUS.NOT_FOUND);
    expect((await verify(token)).status).toBe(HTTP_STATUS.NOT_FOUND);
    const after = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(after.emailVerifiedAt).toBeNull();
  });

  it("a link for a deactivated user is 404", async () => {
    const { user, token } = await unverified();
    await prisma.user.update({
      where: { id: user.id },
      data: { isActive: false },
    });

    expect((await verify(token)).status).toBe(HTTP_STATUS.NOT_FOUND);
  });

  it("a verify link after a reset already verified the address is 204 with no second event", async () => {
    const { user, token } = await unverified();
    await prisma.$transaction((tx) =>
      markEmailVerified(tx, { userId: user.id, via: "password_link" })
    );
    const verifiedAt = (
      await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
    ).emailVerifiedAt;

    expect((await verify(token)).status).toBe(HTTP_STATUS.NO_CONTENT);

    const after = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(after.emailVerifiedAt).toEqual(verifiedAt);
    expect(
      await prisma.auditLogEntry.count({
        where: {
          entityId: user.id,
          metadata: { path: ["action"], equals: "email_verified" },
        },
      })
    ).toBe(1);
    // The link is spent all the same.
    expect((await verify(token)).status).toBe(HTTP_STATUS.NOT_FOUND);
  });

  it("concurrent confirms: one 204, one 404", { tags: ["race"] }, async () => {
    const { token } = await unverified();

    const results = await Promise.all([verify(token), verify(token)]);
    expect(results.map((r) => r.status).sort()).toEqual([204, 404]);
  });
});
