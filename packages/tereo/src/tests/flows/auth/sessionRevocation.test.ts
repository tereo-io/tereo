// @module-tag int
// @module-tag auth
import { getUiAccessTokenForUser } from "../../support/auth/login.js";
import { getTestPrincipalToken } from "../../support/principals.js";
import { createTestClient } from "../../support/auth/clients.js";
import { generateTotpCode } from "../../support/auth/crypto.js";
import { makeServiceOf } from "../../support/testService.js";
import { BASE_URL } from "../../support/auth/constants.js";
import { describe, it, expect, beforeAll } from "vitest";
import { decodeJwt } from "../../support/auth/tokens.js";
import { prisma } from "../../../utils/db/prisma.js";
import {
  REDIRECT_URI,
  POST_LOGOUT_URI,
  sessionLifecycleHelpers,
  type TokenSet,
} from "../../support/auth/sessionLifecycle.js";

let client: Awaited<ReturnType<typeof createTestClient>>;
let introspector: Awaited<ReturnType<typeof createTestClient>>;

const { createUser, refresh, me, login, silentLogin } = sessionLifecycleHelpers(
  () => client
);

beforeAll(async () => {
  // A service in the login client's audience introspects its tokens.
  introspector = await createTestClient({ clientType: "confidential" });
  client = await createTestClient({
    redirectUris: [REDIRECT_URI],
    postLogoutRedirectUris: [POST_LOGOUT_URI],
    audience: [await makeServiceOf(introspector.id)],
  });
});

describe("Session lifecycle", () => {
  describe("revocation endpoints", () => {
    const adminToken = () =>
      getTestPrincipalToken({ permissions: ["users.delete"] });

    it("DELETE /account/sessions/:id kills that session's tokens", async () => {
      const user = await createUser();
      const a = await login(user);
      const b = await login(user);
      const target = await prisma.refreshToken.findFirstOrThrow({
        where: { userId: user.id, revokedAt: null },
        orderBy: { createdAt: "desc" },
      });
      const res = await fetch(`${BASE_URL}/v1/account/sessions/${target.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${a.tokens.access_token}` },
      });
      expect(res.status).toBe(204);
      expect((await refresh(b.tokens.refresh_token)).status).toBe(400);
      expect((await me(b.tokens.access_token)).status).toBe(401);
      expect((await me(a.tokens.access_token)).status).toBe(200);
    });

    /** The session (refresh token id) a browser's access token belongs to. */
    const sessionIdOf = async (tokens: TokenSet) => {
      const { jti } = decodeJwt(tokens.access_token) as unknown as {
        jti: string;
      };
      const row = await prisma.accessToken.findUniqueOrThrow({
        where: { jti },
      });
      expect(row.refreshTokenId).toBeTruthy();
      return row.refreshTokenId!;
    };

    it("DELETE /account/sessions/:id also ends that browser's SSO session, and only that browser's", async () => {
      const user = await createUser();
      const laptop = await login(user);
      const phone = await login(user);

      const res = await fetch(
        `${BASE_URL}/v1/account/sessions/${await sessionIdOf(phone.tokens)}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${laptop.tokens.access_token}` },
        }
      );
      expect(res.status).toBe(204);

      expect((await refresh(phone.tokens.refresh_token)).status).toBe(400);
      expect((await silentLogin(phone.jar)).loggedOut).toBe(true);
      expect(
        (await silentLogin(phone.jar, { org_id: user.orgId })).loggedOut
      ).toBe(true);

      expect((await me(laptop.tokens.access_token)).status).toBe(200);
      const silent = await silentLogin(laptop.jar);
      expect(silent.loggedOut).toBe(false);
    });

    it("DELETE /account/sessions/:id revokes the families the browser got silently", async () => {
      const user = await createUser();
      const laptop = await login(user);
      const other = await login(user);
      const silent = await silentLogin(laptop.jar, { org_id: user.orgId });
      expect(silent.loggedOut).toBe(false);
      const silentTokens = silent.loggedOut ? null : silent.tokens.body;
      expect(silentTokens?.refresh_token).toBeTruthy();

      const res = await fetch(
        `${BASE_URL}/v1/account/sessions/${await sessionIdOf(laptop.tokens)}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${other.tokens.access_token}` },
        }
      );
      expect(res.status).toBe(204);
      expect((await refresh(silentTokens!.refresh_token)).status).toBe(400);
      expect((await me(silentTokens!.access_token)).status).toBe(401);
      expect((await me(other.tokens.access_token)).status).toBe(200);
    });

    it("DELETE /account/sessions/:id answers 404 for another user's session", async () => {
      const owner = await createUser();
      const stranger = await createUser();
      const ownerBrowser = await login(owner);
      const strangerBrowser = await login(stranger);

      const res = await fetch(
        `${BASE_URL}/v1/account/sessions/${await sessionIdOf(ownerBrowser.tokens)}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${strangerBrowser.tokens.access_token}`,
          },
        }
      );
      expect(res.status).toBe(404);
      expect((await me(ownerBrowser.tokens.access_token)).status).toBe(200);
    });

    it("DELETE /admin/users/:id/sessions ends that browser's SSO session, and only that browser's", async () => {
      const user = await createUser();
      const laptop = await login(user);
      const phone = await login(user);

      const res = await fetch(
        `${BASE_URL}/v1/admin/users/${user.id}/sessions`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${await adminToken()}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ sessionId: await sessionIdOf(phone.tokens) }),
        }
      );
      expect(res.status).toBe(204);

      expect((await refresh(phone.tokens.refresh_token)).status).toBe(400);
      expect((await me(phone.tokens.access_token)).status).toBe(401);
      expect((await silentLogin(phone.jar)).loggedOut).toBe(true);
      expect(
        (await silentLogin(phone.jar, { org_id: user.orgId })).loggedOut
      ).toBe(true);

      expect((await me(laptop.tokens.access_token)).status).toBe(200);
      expect((await silentLogin(laptop.jar)).loggedOut).toBe(false);
    });

    it("removing a member ends their sessions in that organization", async () => {
      const user = await createUser();
      const browser = await login(user);
      const { jti } = decodeJwt(browser.tokens.access_token) as unknown as {
        jti: string;
      };
      const row = await prisma.accessToken.findUniqueOrThrow({
        where: { jti },
      });
      expect(row.organizationId).toBe(user.orgId);

      const res = await fetch(
        `${BASE_URL}/v1/admin/organizations/${user.orgId}/members/${user.id}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${await getTestPrincipalToken({
              permissions: ["organizations.write"],
            })}`,
          },
        }
      );
      expect(res.status).toBe(204);

      expect((await me(browser.tokens.access_token)).status).toBe(401);
      expect((await refresh(browser.tokens.refresh_token)).status).toBe(400);
      expect((await silentLogin(browser.jar)).loggedOut).toBe(true);

      const entry = await prisma.auditLogEntry.findFirst({
        where: {
          entityId: user.id,
          entityType: "User",
          metadata: { path: ["action"], equals: "sessions_revoked" },
        },
      });
      expect(entry?.metadata).toMatchObject({
        sessionIds: [await sessionIdOf(browser.tokens)],
      });
    });

    it("single-session revokes are audited and emit auth.user.sessions-revoked", async () => {
      const user = await createUser();
      const browser = await login(user);
      const sessionId = await sessionIdOf(browser.tokens);

      const res = await fetch(
        `${BASE_URL}/v1/admin/users/${user.id}/sessions`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${await adminToken()}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ sessionId }),
        }
      );
      expect(res.status).toBe(204);

      const entry = await prisma.auditLogEntry.findFirst({
        where: {
          entityId: user.id,
          entityType: "User",
          metadata: { path: ["action"], equals: "sessions_revoked" },
        },
      });
      expect(entry?.metadata).toMatchObject({ sessionIds: [sessionId] });
    });

    it("DELETE /account/sessions kills the other sessions' tokens", async () => {
      const user = await createUser();
      const a = await login(user);
      const b = await login(user);
      const res = await fetch(`${BASE_URL}/v1/account/sessions`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${a.tokens.access_token}` },
      });
      expect(res.status).toBe(200);
      expect((await refresh(b.tokens.refresh_token)).status).toBe(400);
      expect((await me(b.tokens.access_token)).status).toBe(401);
      expect((await me(a.tokens.access_token)).status).toBe(200);
    });

    it("DELETE /account/sessions also ends the other browsers' SSO sessions", async () => {
      const user = await createUser();
      const a = await login(user);
      const b = await login(user);
      await fetch(`${BASE_URL}/v1/account/sessions`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${a.tokens.access_token}` },
      });
      expect((await silentLogin(b.jar)).loggedOut).toBe(true);
    });

    it("DELETE /admin/users/:id/sessions/all kills every session's tokens", async () => {
      const user = await createUser();
      const { tokens } = await login(user);
      const res = await fetch(
        `${BASE_URL}/v1/admin/users/${user.id}/sessions/all`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${await adminToken()}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ includeCurrentSession: true }),
        }
      );
      expect(res.status).toBe(200);
      expect((await refresh(tokens.refresh_token)).status).toBe(400);
      expect((await me(tokens.access_token)).status).toBe(401);
    });

    it("DELETE /admin/users/:id/sessions/all also ends the SSO session", async () => {
      const user = await createUser();
      const { jar } = await login(user);
      await fetch(`${BASE_URL}/v1/admin/users/${user.id}/sessions/all`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${await adminToken()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ includeCurrentSession: true }),
      });
      expect((await silentLogin(jar)).loggedOut).toBe(true);
    });

    it("deactivating a user kills tokens, and the SSO session yields no new ones", async () => {
      const user = await createUser();
      const { jar, tokens } = await login(user);
      const res = await fetch(`${BASE_URL}/v1/admin/users/${user.id}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${await adminToken()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ isActive: false }),
      });
      expect(res.status).toBe(200);
      expect((await refresh(tokens.refresh_token)).status).toBe(400);
      expect((await me(tokens.access_token)).status).toBe(401);
      const entry = await prisma.auditLogEntry.findFirst({
        where: {
          entityId: user.id,
          entityType: "User",
          metadata: { path: ["action"], equals: "sessions_revoked" },
        },
      });
      expect(entry?.metadata).toMatchObject({
        sessionIds: [await sessionIdOf(tokens)],
      });

      // prompt=none answers an inactive user's SSO cookie with login_required.
      const silent = await silentLogin(jar);
      expect(silent.loggedOut).toBe(true);
      expect(silent.location.searchParams.get("error")).toBe("login_required");
    });

    it("changing the password kills the other sessions' tokens", async () => {
      const user = await createUser();
      const attacker = await login(user);
      const owner = await login(user);
      const res = await fetch(`${BASE_URL}/v1/account/password`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${owner.tokens.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          currentPassword: user.password,
          newPassword: "An0ther-Long-Passw0rd!",
        }),
      });
      expect(res.status).toBe(200);
      expect((await refresh(attacker.tokens.refresh_token)).status).toBe(400);
      expect((await me(attacker.tokens.access_token)).status).toBe(401);
      expect((await me(owner.tokens.access_token)).status).toBe(200);
    });

    it("changing the password locks out a stolen SSO session", async () => {
      const user = await createUser();
      const attacker = await login(user);
      const owner = await login(user);
      await fetch(`${BASE_URL}/v1/account/password`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${owner.tokens.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          currentPassword: user.password,
          newPassword: "An0ther-Long-Passw0rd!",
        }),
      });
      const silent = await silentLogin(attacker.jar);
      expect(silent.loggedOut || silent.tokens.status !== 200).toBe(true);
    });

    it("enabling TOTP ends the other sessions", async () => {
      const user = await createUser();
      const other = await login(user);
      // 2FA setup is only for core's UI.
      const ownerToken = await getUiAccessTokenForUser({
        id: user.id,
        email: user.email,
        plainPassword: user.password,
      });
      const auth = {
        Authorization: `Bearer ${ownerToken}`,
        "Content-Type": "application/json",
      };
      const setupRes = await fetch(`${BASE_URL}/v1/account/totp/setup`, {
        method: "POST",
        headers: auth,
      });
      expect(setupRes.status).toBe(200);
      const setup = (await setupRes.json()) as {
        secret: string;
        setupToken: string;
      };
      const verify = await fetch(`${BASE_URL}/v1/account/totp/setup/verify`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          setupToken: setup.setupToken,
          totpCode: generateTotpCode(setup.secret),
        }),
      });
      expect(verify.status).toBe(200);
      expect((await refresh(other.tokens.refresh_token)).status).toBe(400);
    });
  });
});
