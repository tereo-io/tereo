import { browserLogin, cookieHeader } from "../utils/browserLogin.js";
import { generateAccessToken } from "../../utils/tokens.js";
import { LOGIN_CLIENT } from "../../definitions/index.js";
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import {
  BASE_URL,
  createTestClient,
  createTestUser,
  decodeJwt,
} from "./utils/test-helpers.js";
import {
  ensureTestMembership,
  ensureTestOrganization,
  getTestPrincipalToken,
  testOrgId,
} from "../utils/principals.js";

/**
 * A socket is authenticated once, at the handshake, with an access token.
 * It is closed when that token's session or the token itself is revoked,
 * and when the token expires; the client reconnects with a fresh token.
 */

const REDIRECT_URI = "http://localhost:3000/websocket-reauth-callback";

let client: Awaited<ReturnType<typeof createTestClient>>;

interface TestSocket {
  /** Resolves with the connect result: null, or the handshake's error. */
  connected: Promise<string | null>;
  /** Resolves when the server closes the connection. */
  closed: Promise<void>;
  /** Event names received, in order. */
  events: { name: string; payload: unknown }[];
  close: () => void;
}

/**
 * A socket.io client over a plain WebSocket (Engine.IO v4): enough of the
 * protocol to connect with a token, receive events and see a disconnect.
 */
const connect = (token: string): TestSocket => {
  const ws = new WebSocket(
    `${BASE_URL.replace(/^http/, "ws")}/ws/?EIO=4&transport=websocket`
  );
  const events: TestSocket["events"] = [];
  let settle: (error: string | null) => void;
  const connected = new Promise<string | null>((r) => (settle = r));
  const closed = new Promise<void>((resolve) =>
    ws.addEventListener("close", () => {
      settle("closed before connecting");
      resolve();
    })
  );
  ws.addEventListener("message", ({ data }) => {
    const packet = String(data);
    if (packet.startsWith("0")) ws.send(`40${JSON.stringify({ token })}`);
    else if (packet === "2") ws.send("3");
    else if (packet.startsWith("40")) settle(null);
    else if (packet.startsWith("44")) {
      settle((JSON.parse(packet.slice(2)) as { message: string }).message);
    } else if (packet.startsWith("42")) {
      const [name, payload] = JSON.parse(packet.slice(2)) as [string, unknown];
      events.push({ name, payload });
    }
  });
  return { connected, closed, events, close: () => ws.close() };
};

const within = <T>(promise: Promise<T>, ms: number, what: string) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${what} within ${ms}ms`)), ms)
    ),
  ]);

/** A browser login through to tokens: a session with a refresh token. */
const signIn = async (scope = "openid core:account") => {
  const user = await createTestUser();
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

  it("refuses a handshake with an expired token", async () => {
    const user = await createTestUser();
    const socket = connect(await shortLivedToken(user.id, -1));
    try {
      expect(await socket.connected).toBe("Invalid or expired access token");
    } finally {
      socket.close();
    }
  });

  /** Resolves true when the socket is still open after a moment. */
  const stillOpen = (socket: TestSocket) =>
    Promise.race([
      socket.closed.then(() => false),
      new Promise<boolean>((r) => setTimeout(() => r(true), 300)),
    ]);

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

describe("Socket scopes", () => {
  it("admits a core:events-only token, which receives its user's events and nothing else", async () => {
    const { user, accessToken } = await signIn("openid core:events");
    const socket = connect(accessToken);
    try {
      expect(await socket.connected).toBeNull();

      const res = await fetch(`${BASE_URL}/v1/admin/users/${user.id}/roles`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${await getTestPrincipalToken({
            permissions: ["users.write"],
          })}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ roleIds: [] }),
      });
      expect(res.status).toBe(200);

      await within(
        (async () => {
          while (
            !socket.events.some((e) => e.name === "auth:permissions:changed")
          ) {
            await new Promise((r) => setTimeout(r, 20));
          }
        })(),
        5000,
        "auth:permissions:changed received"
      );
    } finally {
      socket.close();
    }

    const me = await fetch(`${BASE_URL}/v1/account/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(me.status).toBe(403);
    expect(((await me.json()) as { error: string }).error).toBe(
      "insufficient_scope"
    );
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
