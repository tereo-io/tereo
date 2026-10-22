// @module-tag int
// @module-tag auth
// @module-tag job
import { createTestClient, createTestUser } from "../support/auth.js";
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import { randomBytes } from "node:crypto";
import {
  AUTH_TOKEN_GRACE_MS,
  cleanupExpiredAuthRows,
} from "../../jobs/authCleanup.js";

const DAY = 24 * 60 * 60 * 1000;
const at = (offsetMs: number) => new Date(Date.now() + offsetMs);
const unique = () => randomBytes(16).toString("hex");

let clientId: string;
let userId: string;

const code = (expiresAt: Date) =>
  prisma.authorizationCode.create({
    data: {
      codeHash: unique(),
      clientId,
      userId,
      redirectUri: "http://localhost:3000/callback",
      scopes: [],
      codeChallenge: unique(),
      codeChallengeMethod: "S256",
      authTime: new Date(),
      expiresAt,
    },
  });

const refreshToken = (
  expiresAt: Date,
  extra: { authCodeId?: string; revokedAt?: Date } = {}
) =>
  prisma.refreshToken.create({
    data: {
      tokenHash: unique(),
      clientId,
      userId,
      scopes: [],
      expiresAt,
      ...extra,
    },
  });

const accessToken = (expiresAt: Date) =>
  prisma.accessToken.create({
    data: { jti: unique(), clientId, userId, scopes: [], expiresAt },
  });

const userSession = (expiresAt: Date) =>
  prisma.userSession.create({
    data: {
      tokenHash: unique(),
      userId,
      authTime: new Date(),
      expiresAt,
    },
  });

const exists = {
  code: (id: string) => prisma.authorizationCode.findUnique({ where: { id } }),
  refresh: (id: string) => prisma.refreshToken.findUnique({ where: { id } }),
  access: (id: string) => prisma.accessToken.findUnique({ where: { id } }),
  session: (id: string) => prisma.userSession.findUnique({ where: { id } }),
};

beforeAll(async () => {
  clientId = (await createTestClient()).id;
  userId = (await createTestUser()).id;
});

describe("auth cleanup", () => {
  it("deletes tokens and codes only after the grace period", async () => {
    const pastGrace = -AUTH_TOKEN_GRACE_MS - DAY;

    const oldAccess = await accessToken(at(pastGrace));
    const recentAccess = await accessToken(at(-DAY));
    const liveAccess = await accessToken(at(DAY));

    const oldRefresh = await refreshToken(at(pastGrace));
    const recentRefresh = await refreshToken(at(-DAY));

    const deadCode = await code(at(pastGrace));

    await cleanupExpiredAuthRows();

    expect(await exists.access(oldAccess.id)).toBeNull();
    expect(await exists.access(recentAccess.id)).not.toBeNull();
    expect(await exists.access(liveAccess.id)).not.toBeNull();
    expect(await exists.refresh(oldRefresh.id)).toBeNull();
    expect(await exists.refresh(recentRefresh.id)).not.toBeNull();
    expect(await exists.code(deadCode.id)).toBeNull();
  });

  it("keeps a revoked refresh token until its family expires, for reuse detection", async () => {
    const familyCode = await code(at(-AUTH_TOKEN_GRACE_MS - DAY));
    const revoked = await refreshToken(at(DAY), {
      authCodeId: familyCode.id,
      revokedAt: at(-AUTH_TOKEN_GRACE_MS - DAY),
    });

    await cleanupExpiredAuthRows();

    expect(await exists.refresh(revoked.id)).not.toBeNull();
    // Deleting the code would cascade to its family.
    expect(await exists.code(familyCode.id)).not.toBeNull();
  });

  it("deletes a code once its family's tokens are gone", async () => {
    const pastGrace = at(-AUTH_TOKEN_GRACE_MS - DAY);
    const familyCode = await code(pastGrace);
    const familyToken = await refreshToken(pastGrace, {
      authCodeId: familyCode.id,
    });

    await cleanupExpiredAuthRows();

    expect(await exists.refresh(familyToken.id)).toBeNull();
    expect(await exists.code(familyCode.id)).toBeNull();
  });

  it("deletes expired sessions and TOTP setup grants as soon as they expire", async () => {
    const expired = await userSession(at(-1000));
    const live = await userSession(at(DAY));
    const grant = await prisma.totpSetupGrant.create({
      data: {
        tokenHash: unique(),
        userId,
        clientId,
        redirectUri: "http://localhost:3000/callback",
        scopes: [],
        codeChallenge: unique(),
        codeChallengeMethod: "S256",
        expiresAt: at(-1000),
      },
    });

    const deleted = await cleanupExpiredAuthRows();

    expect(await exists.session(expired.id)).toBeNull();
    expect(await exists.session(live.id)).not.toBeNull();
    expect(
      await prisma.totpSetupGrant.findUnique({ where: { id: grant.id } })
    ).toBeNull();
    expect(deleted.userSessions).toBeGreaterThanOrEqual(1);
    expect(deleted.totpSetupGrants).toBeGreaterThanOrEqual(1);
  });

  it("removes expired upstream sessions, link grants and identity invites", async () => {
    const provider = await prisma.identityProvider.create({
      data: {
        slug: `cleanup-${unique().slice(0, 12)}`,
        displayName: "Cleanup",
        kind: "oidc",
        issuer: "https://idp.test.local",
        clientId: "cid",
        clientSecret: "sealed",
        createdBy: userId,
      },
    });
    const inviteUser = await createTestUser();

    const upstream = (expiresAt: Date) =>
      prisma.upstreamAuthSession.create({
        data: {
          stateHash: unique(),
          providerId: provider.id,
          purpose: "login",
          nonce: unique(),
          codeVerifier: unique(),
          expiresAt,
        },
      });
    const grant = (expiresAt: Date) =>
      prisma.identityLinkGrant.create({
        data: {
          tokenHash: unique(),
          userId,
          clientId,
          redirectUri: "http://localhost:3000/callback",
          scopes: [],
          codeChallenge: unique(),
          codeChallengeMethod: "S256",
          expiresAt,
        },
      });

    const expiredSession = await upstream(at(-1000));
    const liveSession = await upstream(at(DAY));
    const expiredGrant = await grant(at(-1000));
    const liveGrant = await grant(at(DAY));
    const expiredInvite = await prisma.identityInvite.create({
      data: {
        userId: inviteUser.id,
        providerId: provider.id,
        createdBy: userId,
        expiresAt: at(-1000),
      },
    });
    const liveUser = await createTestUser();
    const liveInvite = await prisma.identityInvite.create({
      data: {
        userId: liveUser.id,
        providerId: provider.id,
        createdBy: userId,
        expiresAt: at(DAY),
      },
    });

    const deleted = await cleanupExpiredAuthRows();

    expect(deleted.upstreamAuthSessions).toBe(1);
    expect(deleted.identityLinkGrants).toBe(1);
    expect(deleted.identityInvites).toBe(1);
    const gone = [
      await prisma.upstreamAuthSession.findUnique({
        where: { id: expiredSession.id },
      }),
      await prisma.identityLinkGrant.findUnique({
        where: { id: expiredGrant.id },
      }),
      await prisma.identityInvite.findUnique({
        where: { id: expiredInvite.id },
      }),
    ];
    expect(gone).toEqual([null, null, null]);
    expect(
      await prisma.upstreamAuthSession.findUnique({
        where: { id: liveSession.id },
      })
    ).not.toBeNull();
    expect(
      await prisma.identityLinkGrant.findUnique({ where: { id: liveGrant.id } })
    ).not.toBeNull();
    expect(
      await prisma.identityInvite.findUnique({ where: { id: liveInvite.id } })
    ).not.toBeNull();
  });
});
