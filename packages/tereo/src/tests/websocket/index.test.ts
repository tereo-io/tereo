// @module-tag int
// @module-tag auth
// @module-tag platform
import { notifyBucketAccessChanged } from "../../websocket/emitters/index.js";
import { closeRedisEmitter } from "../../websocket/emitters/redisEmitter.js";
import { browserLogin, cookieHeader } from "../support/browserLogin.js";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { generateAccessToken } from "../../utils/tokens.js";
import { closeHttpServer } from "../../utils/httpServer.js";
import { LOGIN_CLIENT } from "../../definitions/index.js";
import { createServer, type Server } from "node:http";
import { prisma } from "../../utils/db/prisma.js";
import {
  ensureTestMembership,
  ensureTestOrganization,
  getTestPrincipalToken,
  testOrgId,
} from "../support/principals.js";
import {
  disconnectWebSocketClients,
  initializeWebSocket,
  shutdownWebSocket,
} from "../../websocket/index.js";
import {
  connect,
  received,
  stillOpen,
  within,
  type TestSocket,
} from "../support/socket.js";
import {
  BASE_URL,
  createTestClient,
  createTestUser,
  decodeJwt,
} from "../support/auth.js";

describe("initializeWebSocket", () => {
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

  const refresh = (refreshToken: string) =>
    fetch(`${BASE_URL}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client.clientId,
        refresh_token: refreshToken,
      }),
    });

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

  describe("WebSocket re-authentication", () => {
    it("closes the socket when its session is revoked, and only that one", async () => {
      const mine = await signIn();
      const other = await signIn();
      const socket = connect(mine.accessToken);
      const bystander = connect(other.accessToken);
      try {
        expect(await socket.connected).toBeNull();
        expect(await bystander.connected).toBeNull();

        const res = await fetch(
          `${BASE_URL}/v1/account/sessions/${mine.sessionId}`,
          {
            method: "DELETE",
            headers: { Authorization: `Bearer ${mine.accessToken}` },
          }
        );
        expect(res.status).toBe(204);

        await within(socket.closed, 5000, "socket closed");
        expect(socket.events).toContainEqual({
          name: "auth:session:revoked",
          payload: expect.objectContaining({ sessionId: mine.sessionId }),
        });

        // A session of another user is untouched.
        const stillOpen = await Promise.race([
          bystander.closed.then(() => false),
          new Promise<boolean>((r) => setTimeout(() => r(true), 300)),
        ]);
        expect(stillOpen).toBe(true);
      } finally {
        socket.close();
        bystander.close();
      }
    });

    it("closes the family's sockets when a rotated refresh token is reused", async () => {
      const { user, accessToken, refreshToken } = await signIn();
      const socket = connect(accessToken);
      try {
        expect(await socket.connected).toBeNull();
        expect((await refresh(refreshToken)).status).toBe(200);
        // Past the grace a concurrent refresh gets: this replay is reuse.
        await prisma.refreshToken.updateMany({
          where: { userId: user.id, rotatedAt: { not: null } },
          data: { rotatedAt: new Date(Date.now() - 60_000) },
        });
        expect((await refresh(refreshToken)).status).toBe(400);

        await within(socket.closed, 5000, "socket closed");
      } finally {
        socket.close();
      }
    });

    it("closes a refreshed-away token's socket at sign-out everywhere, not the caller's", async () => {
      const first = await signIn();
      const rotated = connect(first.accessToken);
      const caller = await signIn("openid core:account", first.user);
      const callerSocket = connect(caller.accessToken);
      let current: TestSocket | null = null;
      try {
        expect(await rotated.connected).toBeNull();
        expect(await callerSocket.connected).toBeNull();
        const res = await refresh(first.refreshToken);
        expect(res.status).toBe(200);
        const { access_token } = (await res.json()) as { access_token: string };
        current = connect(access_token);
        expect(await current.connected).toBeNull();

        const signOut = await fetch(`${BASE_URL}/v1/account/sessions`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${caller.accessToken}` },
        });
        expect(signOut.status).toBe(200);

        await within(rotated.closed, 5000, "rotated token's socket closed");
        await within(current.closed, 5000, "current token's socket closed");
        expect(await stillOpen(callerSocket)).toBe(true);
      } finally {
        rotated.close();
        callerSocket.close();
        current?.close();
      }
    });

    it("closes the socket of a refresh token without a family whose organization was lost", async () => {
      const { user, accessToken, refreshToken, sessionId } = await signIn();
      const lost = await ensureTestOrganization(`ws-lost-${user.id}`);
      await prisma.refreshToken.update({
        where: { id: sessionId },
        data: { organizationId: lost, authCodeId: null },
      });
      const socket = connect(accessToken);
      try {
        expect(await socket.connected).toBeNull();
        expect((await refresh(refreshToken)).status).toBe(400);
        await within(socket.closed, 5000, "socket closed");
      } finally {
        socket.close();
      }
    });

    it("closes the socket when its access token is revoked", async () => {
      const { accessToken } = await signIn();
      const socket = connect(accessToken);
      try {
        expect(await socket.connected).toBeNull();

        const res = await fetch(`${BASE_URL}/oauth/revoke`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            token: accessToken,
            client_id: client.clientId,
          }),
        });
        expect(res.status).toBe(200);

        await within(socket.closed, 5000, "socket closed");
      } finally {
        socket.close();
      }
    });

    it("closes the socket when its token expires, and a fresh token reconnects", async () => {
      const user = await createTestUser();
      const socket = connect(await shortLivedToken(user.id, 2));
      let fresh: TestSocket | null = null;
      try {
        expect(await socket.connected).toBeNull();
        const started = Date.now();
        await within(socket.closed, 6000, "socket closed at expiry");
        expect(Date.now() - started).toBeGreaterThan(500);

        fresh = connect(await shortLivedToken(user.id, 600));
        expect(await fresh.connected).toBeNull();
      } finally {
        socket.close();
        fresh?.close();
      }
    });

    it("caps one user's sockets on a node, and frees a slot on close", async () => {
      const { accessToken } = await signIn();
      const sockets = Array.from({ length: 20 }, () => connect(accessToken));
      try {
        for (const s of sockets) expect(await s.connected).toBeNull();
        const extra = connect(accessToken);
        expect(await extra.connected).toBe("Too many connections");
        extra.close();

        sockets[0].close();
        await within(sockets[0].closed, 5000, "socket closed");
        // The server counts the close once it sees it.
        await new Promise((r) => setTimeout(r, 200));
        const again = connect(accessToken);
        expect(await again.connected).toBeNull();
        again.close();
      } finally {
        for (const s of sockets) s.close();
      }
    });

    it("caps handshakes in flight together", async () => {
      const { accessToken } = await signIn();
      const sockets = Array.from({ length: 25 }, () => connect(accessToken));
      try {
        const results = await Promise.all(sockets.map((s) => s.connected));
        expect(results.filter((r) => r === null)).toHaveLength(20);
        expect(
          results.filter((r) => r === "Too many connections")
        ).toHaveLength(5);
      } finally {
        for (const s of sockets) s.close();
      }
    });

    it("refuses a token that is not a string, or too long to be one of core's", async () => {
      const user = await createTestUser();
      const token = await shortLivedToken(user.id, 600);
      for (const bad of [
        42,
        { token },
        [token],
        `${token}${"a".repeat(8192)}`,
      ]) {
        const socket = connect(bad);
        try {
          expect(await socket.connected).toBe("Invalid access token");
        } finally {
          socket.close();
        }
      }
    });

    it("drops pings past the burst, and closes a socket that keeps flooding", async () => {
      const socket = connect(
        await shortLivedToken((await createTestUser()).id, 600)
      );
      try {
        expect(await socket.connected).toBeNull();
        for (let i = 0; i < 15; i++) socket.emit("auth:ping");
        await new Promise((r) => setTimeout(r, 300));
        const pongs = socket.events.filter((e) => e.name === "auth:pong");
        expect(pongs.length).toBeGreaterThanOrEqual(10);
        expect(pongs.length).toBeLessThan(15);
        expect(await stillOpen(socket)).toBe(true);

        for (let i = 0; i < 50; i++) socket.emit("auth:ping");
        await within(socket.closed, 5000, "flooding socket closed");
      } finally {
        socket.close();
      }
    });

    it("refuses a handshake with an expired token", async () => {
      const user = await createTestUser();
      const socket = connect(await shortLivedToken(user.id, -1));
      try {
        expect(await socket.connected).toBe("Invalid or expired access token");
      } finally {
        socket.close();
      }
    });

    it("closes every socket of a deactivated user, sessions or not", async () => {
      const { user, accessToken } = await signIn();
      const withSession = connect(accessToken);
      const sessionless = connect(await shortLivedToken(user.id, 600));
      const bystander = connect(
        await shortLivedToken((await createTestUser()).id, 600)
      );
      try {
        for (const s of [withSession, sessionless, bystander]) {
          expect(await s.connected).toBeNull();
        }

        const res = await fetch(`${BASE_URL}/v1/admin/users/${user.id}`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${await getTestPrincipalToken({
              permissions: ["users.write"],
            })}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ isActive: false }),
        });
        expect(res.status).toBe(200);

        await within(withSession.closed, 5000, "session socket closed");
        await within(sessionless.closed, 5000, "sessionless socket closed");
        expect(await stillOpen(bystander)).toBe(true);
      } finally {
        for (const s of [withSession, sessionless, bystander]) s.close();
      }
    });

    it("closes a sessionless token's socket when its user is signed out everywhere", async () => {
      const user = await createTestUser();
      const sessionless = connect(await shortLivedToken(user.id, 600));
      try {
        expect(await sessionless.connected).toBeNull();

        const res = await fetch(
          `${BASE_URL}/v1/admin/users/${user.id}/sessions/all`,
          {
            method: "DELETE",
            headers: {
              Authorization: `Bearer ${await getTestPrincipalToken({
                permissions: ["users.delete"],
              })}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ includeCurrentSession: true }),
          }
        );
        expect(res.status).toBe(200);

        await within(sessionless.closed, 5000, "sessionless socket closed");
      } finally {
        sessionless.close();
      }
    });

    it("closes the socket of a token without a refresh token at its browser's logout", async () => {
      const noRefresh = await createTestClient({
        redirectUris: [REDIRECT_URI],
        grantTypes: ["authorization_code"],
      });
      const user = await createTestUser();
      const jar = new Map<string, string>();
      const login = await browserLogin({
        clientId: noRefresh.clientId,
        redirectUri: REDIRECT_URI,
        scope: "openid core:account",
        email: user.email,
        password: user.plainPassword,
        jar,
      });
      const tokens = await fetch(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: noRefresh.clientId,
          code: login.code,
          redirect_uri: REDIRECT_URI,
          code_verifier: login.verifier,
        }),
      });
      expect(tokens.status).toBe(200);
      const { access_token, id_token } = (await tokens.json()) as {
        access_token: string;
        id_token: string;
      };
      const socket = connect(access_token);
      try {
        expect(await socket.connected).toBeNull();

        const res = await fetch(`${BASE_URL}/oauth/end-session`, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Cookie: cookieHeader(jar),
          },
          body: new URLSearchParams({ id_token_hint: id_token }),
          redirect: "manual",
        });
        expect(res.status).toBe(200);

        await within(socket.closed, 5000, "socket closed");
      } finally {
        socket.close();
      }
    });

    it("closes a removed member's sockets in that organization only", async () => {
      const user = await createTestUser();
      const removedFrom = `ws-removed-${user.id}`;
      const keptIn = `ws-kept-${user.id}`;
      await ensureTestMembership(user.id, removedFrom);
      await ensureTestMembership(user.id, keptIn);
      const there = connect(
        await shortLivedToken(user.id, 600, testOrgId(removedFrom))
      );
      const elsewhere = connect(
        await shortLivedToken(user.id, 600, testOrgId(keptIn))
      );
      try {
        expect(await there.connected).toBeNull();
        expect(await elsewhere.connected).toBeNull();

        const res = await fetch(
          `${BASE_URL}/v1/admin/organizations/${testOrgId(removedFrom)}/members/${user.id}`,
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

        await within(there.closed, 5000, "socket in the organization closed");
        expect(await stillOpen(elsewhere)).toBe(true);
      } finally {
        there.close();
        elsewhere.close();
      }
    });
  });

  describe("Socket scopes", () => {
    it("admits a core:events-only token, which hears of permission changes and its own session only", async () => {
      const { user, accessToken, sessionId } =
        await signIn("openid core:events");
      const other = await signIn("openid core:account", user);
      const socket = connect(accessToken);
      const full = connect(await shortLivedToken(user.id, 600));
      try {
        expect(await socket.connected).toBeNull();
        expect(await full.connected).toBeNull();

        const roles = await fetch(
          `${BASE_URL}/v1/admin/users/${user.id}/roles`,
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${await getTestPrincipalToken({
                permissions: ["users.write"],
              })}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ roleIds: [] }),
          }
        );
        expect(roles.status).toBe(200);
        await received(socket, "auth:permissions:changed");

        // The user's other sessions, organizations and buckets are not its to see.
        const endOther = await fetch(
          `${BASE_URL}/v1/account/sessions/${other.sessionId}`,
          {
            method: "DELETE",
            headers: { Authorization: `Bearer ${other.accessToken}` },
          }
        );
        expect(endOther.status).toBe(204);
        const orgId = await ensureTestOrganization(`ws-events-${user.id}`);
        const added = await fetch(
          `${BASE_URL}/v1/admin/organizations/${orgId}/members`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${await getTestPrincipalToken({
                permissions: ["organizations.write"],
              })}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ userId: user.id, memberRole: "member" }),
          }
        );
        expect(added.status).toBe(201);
        notifyBucketAccessChanged([user.id], `ws-events-${user.id}`);

        for (const name of [
          "auth:session:revoked",
          "auth:organization:changed",
          "files:bucket-access:changed",
        ]) {
          await received(full, name);
        }
        expect(socket.events.map((e) => e.name)).toEqual([
          "auth:permissions:changed",
        ]);

        const me = await fetch(`${BASE_URL}/v1/account/me`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        expect(me.status).toBe(403);
        expect(((await me.json()) as { error: string }).error).toBe(
          "insufficient_scope"
        );

        const endOwn = await fetch(
          `${BASE_URL}/v1/admin/users/${user.id}/sessions`,
          {
            method: "DELETE",
            headers: {
              Authorization: `Bearer ${await getTestPrincipalToken({
                permissions: ["users.delete"],
              })}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ sessionId }),
          }
        );
        expect(endOwn.status).toBe(204);
        await within(socket.closed, 5000, "socket closed");
        expect(socket.events).toContainEqual({
          name: "auth:session:revoked",
          payload: expect.objectContaining({ sessionId }),
        });
      } finally {
        socket.close();
        full.close();
      }
    });

    it("refuses a token whose core scopes open neither account nor events", async () => {
      const { accessToken } = await signIn("openid core:organizations");
      const socket = connect(accessToken);
      try {
        expect(await socket.connected).toBe(
          "This token is not issued for core's API"
        );
      } finally {
        socket.close();
      }
    });
  });
});

// The describes above must run before the in-process shutdownWebSocket tests
// below: shutdownWebSocket clears websocket/index's io, but permissionEmitters
// keeps its own module-level io pointing at the dead server, so the core
// server's events would no longer reach these sockets.

/**
 * A socket's token can die without anything closing the socket — its session
 * rotated away by a refresh is one. Each node checks its sockets' tokens
 * again every WEBSOCKET_REVALIDATE_INTERVAL_SECONDS and closes those.
 */

const REDIRECT_URI = "http://localhost:3000/websocket-revalidate-callback";

const listen = (server: Server) =>
  new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve((server.address() as { port: number }).port)
    );
  });

const token = (body: Record<string, string>) =>
  fetch(`${BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });

describe("revalidateLocalSockets", () => {
  it("closes the socket of a token whose session a refresh rotated away", async () => {
    const client = await createTestClient({ redirectUris: [REDIRECT_URI] });
    const user = await createTestUser();
    const login = await browserLogin({
      clientId: client.clientId,
      redirectUri: REDIRECT_URI,
      scope: "openid core:account",
      email: user.email,
      password: user.plainPassword,
    });
    const issued = await token({
      grant_type: "authorization_code",
      client_id: client.clientId,
      code: login.code,
      redirect_uri: REDIRECT_URI,
      code_verifier: login.verifier,
    });
    expect(issued.status).toBe(200);
    const first = (await issued.json()) as {
      access_token: string;
      refresh_token: string;
    };

    // A server of this process's own, re-checking every second.
    const saved = process.env.WEBSOCKET_REVALIDATE_INTERVAL_SECONDS;
    process.env.WEBSOCKET_REVALIDATE_INTERVAL_SECONDS = "1";
    vi.resetModules();
    // The fresh modules verify tokens with keys of their own loading.
    await (await import("../../utils/keys.js")).loadKeys();
    const ws = await import("../../websocket/index.js");
    const server = createServer();
    await ws.initializeWebSocket(server);
    const url = `http://127.0.0.1:${await listen(server)}`;

    const rotated = connect(first.access_token, url);
    let current: ReturnType<typeof connect> | null = null;
    try {
      expect(await rotated.connected).toBeNull();
      const refreshed = await token({
        grant_type: "refresh_token",
        client_id: client.clientId,
        refresh_token: first.refresh_token,
      });
      expect(refreshed.status).toBe(200);
      const { access_token } = (await refreshed.json()) as {
        access_token: string;
      };
      current = connect(access_token, url);
      expect(await current.connected).toBeNull();

      await within(rotated.closed, 5000, "rotated token's socket closed");
      expect(await stillOpen(current, 1500)).toBe(true);
    } finally {
      rotated.close();
      current?.close();
      await ws.shutdownWebSocket();
      server.closeAllConnections();
      server.close();
      if (saved === undefined) {
        delete process.env.WEBSOCKET_REVALIDATE_INTERVAL_SECONDS;
      } else process.env.WEBSOCKET_REVALIDATE_INTERVAL_SECONDS = saved;
      vi.resetModules();
    }
  }, 30_000);
});

describe("shutdownWebSocket", () => {
  it("closes the HTTP server without waiting out the drain window", async () => {
    const server = createServer();
    await initializeWebSocket(server);
    const port = await listen(server);

    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws/?EIO=4&transport=websocket`
    );
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("ws error")));
    });
    const wsClosed = new Promise<void>((resolve) =>
      ws.addEventListener("close", () => resolve())
    );

    try {
      const started = Date.now();
      // A drain window far beyond the test timeout: only closing the
      // upgraded socket lets this resolve.
      await closeHttpServer(server, disconnectWebSocketClients, 600_000);
      expect(Date.now() - started).toBeLessThan(5_000);
      await wsClosed;
    } finally {
      await shutdownWebSocket();
      server.closeAllConnections();
    }
  }, 15_000);
});
