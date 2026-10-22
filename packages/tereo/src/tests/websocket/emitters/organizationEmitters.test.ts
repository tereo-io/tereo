// @module-tag int
// @module-tag auth
import { closeRedisEmitter } from "../../../websocket/emitters/redisEmitter.js";
import { connect, within, type TestSocket } from "../../support/socket.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestClient } from "../../support/auth/clients.js";
import { generateAccessToken } from "../../../utils/tokens.js";
import { browserLogin } from "../../support/browserLogin.js";
import { LOGIN_CLIENT } from "../../../definitions/index.js";
import { createTestUser } from "../../support/auth/users.js";
import { BASE_URL } from "../../support/auth/constants.js";
import { decodeJwt } from "../../support/auth/tokens.js";
import { prisma } from "../../../utils/db/prisma.js";
import {
  ensureTestMembership,
  ensureTestOrganization,
  getTestPrincipalToken,
  testOrgId,
} from "../../support/principals.js";

const REDIRECT_URI = "http://localhost:3000/websocket-reauth-callback";

let client: Awaited<ReturnType<typeof createTestClient>>;

type TestUser = Awaited<ReturnType<typeof createTestUser>>;

/** A browser login through to tokens: a session with a refresh token. */
const signIn = async (
  scope = "openid core:account",
  existing: TestUser | null = null
) => {
  const user = existing ?? (await createTestUser());
  const login = await browserLogin({
    clientId: client.clientId,
    redirectUri: REDIRECT_URI,
    scope,
    email: user.email,
    password: user.plainPassword,
  });
  const res = await fetch(`${BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.clientId,
      code: login.code,
      redirect_uri: REDIRECT_URI,
      code_verifier: login.verifier,
    }),
  });
  expect(res.status).toBe(200);
  const { access_token, refresh_token } = (await res.json()) as {
    access_token: string;
    refresh_token: string;
  };
  const { sid } = decodeJwt(access_token) as unknown as { sid: string };
  return {
    user,
    accessToken: access_token,
    refreshToken: refresh_token,
    sessionId: sid,
  };
};

/**
 * An access token for core's login client, with no session behind it, that
 * expires in `seconds` — for `organizationId` when given.
 */
const shortLivedToken = async (
  userId: string,
  seconds: number,
  organizationId: string | null = null
) => {
  const loginClient = await prisma.oAuthClient.findFirstOrThrow({
    where: { clientId: LOGIN_CLIENT.clientId },
  });
  const { token, jti, expiresAt } = generateAccessToken({
    subject: userId,
    clientId: loginClient.clientId,
    scopes: [],
    expiresIn: seconds,
    organizationId: organizationId ?? undefined,
  });
  await prisma.accessToken.create({
    data: {
      jti,
      clientId: loginClient.id,
      userId,
      organizationId,
      scopes: [],
      expiresAt,
    },
  });
  return token;
};

beforeAll(async () => {
  client = await createTestClient({ redirectUris: [REDIRECT_URI] });
});

// The bucket test emits from this process, through Redis.
afterAll(async () => {
  await closeRedisEmitter();
});

/** Resolves with the first `auth:organization:changed` event's payload. */
const orgChange = async (socket: TestSocket) => {
  const find = () =>
    socket.events.find((e) => e.name === "auth:organization:changed");
  await within(
    (async () => {
      while (!find()) await new Promise((r) => setTimeout(r, 20));
    })(),
    5000,
    "auth:organization:changed received"
  );
  return find()!.payload;
};

describe("organizationEmitters", () => {
  describe("Organization change events", () => {
    const call = async (method: string, path: string, body?: unknown) =>
      fetch(`${BASE_URL}/v1/admin/organizations/${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${await getTestPrincipalToken({
            permissions: ["organizations.write"],
          })}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    it("tells a user they were added to an organization", async () => {
      const user = await createTestUser();
      const orgId = await ensureTestOrganization(`ws-added-${user.id}`);
      const socket = connect(await shortLivedToken(user.id, 600));
      try {
        expect(await socket.connected).toBeNull();

        const res = await call("POST", `${orgId}/members`, {
          userId: user.id,
          memberRole: "member",
        });
        expect(res.status).toBe(201);

        expect(await orgChange(socket)).toMatchObject({
          reason: "membership_changed",
          organizationId: orgId,
        });
      } finally {
        socket.close();
      }
    });

    it("tells a member their member tier changed", async () => {
      const user = await createTestUser();
      const orgId = testOrgId(`ws-tier-${user.id}`);
      await ensureTestMembership(user.id, orgId);
      const socket = connect(await shortLivedToken(user.id, 600));
      try {
        expect(await socket.connected).toBeNull();

        const res = await call("PATCH", `${orgId}/members/${user.id}`, {
          memberRole: "admin",
        });
        expect(res.status).toBe(200);

        expect(await orgChange(socket)).toMatchObject({
          reason: "membership_changed",
          organizationId: orgId,
        });
      } finally {
        socket.close();
      }
    });

    it("tells a member their organization roles changed", async () => {
      const user = await createTestUser();
      const orgId = testOrgId(`ws-roles-${user.id}`);
      await ensureTestMembership(user.id, orgId);
      const socket = connect(await shortLivedToken(user.id, 600, orgId));
      try {
        expect(await socket.connected).toBeNull();

        const res = await call("PUT", `${orgId}/members/${user.id}/roles`, {
          roleIds: [],
        });
        expect(res.status).toBe(200);

        expect(await orgChange(socket)).toMatchObject({
          reason: "roles_changed",
          organizationId: orgId,
        });
      } finally {
        socket.close();
      }
    });

    it("tells a removed member's sockets outside the organization", async () => {
      const user = await createTestUser();
      const orgId = testOrgId(`ws-left-${user.id}`);
      await ensureTestMembership(user.id, orgId);
      const elsewhere = connect(await shortLivedToken(user.id, 600));
      try {
        expect(await elsewhere.connected).toBeNull();

        const res = await call("DELETE", `${orgId}/members/${user.id}`);
        expect(res.status).toBe(204);

        expect(await orgChange(elsewhere)).toMatchObject({
          reason: "membership_changed",
          organizationId: orgId,
        });
      } finally {
        elsewhere.close();
      }
    });

    it("tells a deactivated organization's members before closing its sockets", async () => {
      const { user, accessToken } = await signIn();
      const orgId = testOrgId(`ws-deactivated-${user.id}`);
      await ensureTestMembership(user.id, orgId);
      const there = connect(await shortLivedToken(user.id, 600, orgId));
      const elsewhere = connect(accessToken);
      try {
        expect(await there.connected).toBeNull();
        expect(await elsewhere.connected).toBeNull();

        const res = await call("PATCH", orgId, { isActive: false });
        expect(res.status).toBe(200);

        await within(there.closed, 5000, "socket in the organization closed");
        const expected = { reason: "org_deactivated", organizationId: orgId };
        expect(there.events).toContainEqual({
          name: "auth:organization:changed",
          payload: expect.objectContaining(expected),
        });
        // The member's session outside the organization survives.
        expect(await orgChange(elsewhere)).toMatchObject(expected);
        expect(elsewhere.events.map((e) => e.name)).not.toContain(
          "auth:session:revoked"
        );
      } finally {
        there.close();
        elsewhere.close();
      }
    });
  });
});
