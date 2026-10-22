import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import {
  DEFAULT_ORGANIZATION_ID,
  SYSTEM_USER_ID,
} from "../../definitions/index.js";
import {
  absorbCookies,
  browserLogin,
  cookieHeader,
  newPkce,
  type CookieJar,
} from "../support/browserLogin.js";
import {
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../support/webhooks.js";
import {
  BASE_URL,
  HTTP_STATUS,
  createTestClient,
  createTestUser,
  decodeJwt,
} from "../support/auth.js";

/**
 * What the token lifecycle leaves behind: audit entries and
 * `auth.user.sessions-revoked` events for reuse detection, /oauth/revoke,
 * end-session and a browser handed to another user.
 */

const REDIRECT_URI = "http://localhost:3000/token-lifecycle-audit-callback";
const SCOPE = "openid offline_access";

type TestUser = Awaited<ReturnType<typeof createTestUser>>;

let client: Awaited<ReturnType<typeof createTestClient>>;
let endpointId: string;

beforeAll(async () => {
  client = await createTestClient({ redirectUris: [REDIRECT_URI] });
  const endpoint = await createTestWebhookEndpoint(
    await getCoreEventSubscriberToken(DEFAULT_ORGANIZATION_ID),
    { eventTypes: ["auth.user.sessions-revoked"] }
  );
  endpointId = endpoint.id;
});

const exchange = (code: string, verifier: string) =>
  fetch(`${BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.clientId,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });

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

const revoke = (token: string) =>
  fetch(`${BASE_URL}/oauth/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token, client_id: client.clientId }),
  });

interface Tokens {
  access_token: string;
  refresh_token: string;
  id_token: string;
}

const signIn = async (user?: TestUser, jar?: CookieJar) => {
  const u = user ?? (await createTestUser());
  const login = await browserLogin({
    clientId: client.clientId,
    redirectUri: REDIRECT_URI,
    scope: SCOPE,
    email: u.email,
    password: u.plainPassword,
    jar,
  });
  const res = await exchange(login.code, login.verifier);
  expect(res.status).toBe(HTTP_STATUS.OK);
  return {
    user: u,
    jar: login.jar,
    code: login.code,
    verifier: login.verifier,
    tokens: (await res.json()) as Tokens,
  };
};

const sidOf = (accessToken: string) =>
  (decodeJwt(accessToken) as unknown as { sid: string }).sid;

const entriesOf = (userId: string) =>
  prisma.auditLogEntry.findMany({
    where: { entityType: "User", entityId: userId },
    orderBy: { createdAt: "asc" },
  });

const revokedEventsFor = (userId: string) =>
  prisma.webhookDelivery.count({
    where: {
      webhookEndpointId: endpointId,
      eventType: "auth.user.sessions-revoked",
      payload: { path: ["entityId"], equals: userId },
    },
  });

const expectRevokedEvent = (userId: string) =>
  waitFor(async () => (await revokedEventsFor(userId)) > 0, 10_000);

describe("token reuse", () => {
  it("audits a replayed authorization code as core and emits the revocation", async () => {
    const { user, code, verifier, tokens } = await signIn();

    const replay = await exchange(code, verifier);
    expect(replay.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(((await replay.json()) as { error: string }).error).toBe(
      "invalid_grant"
    );

    const authCode = await prisma.authorizationCode.findFirstOrThrow({
      where: { userId: user.id, clientId: client.id },
    });
    const entry = (await entriesOf(user.id)).find(
      (e) =>
        (e.metadata as { action?: string } | null)?.action ===
        "token_reuse_detected"
    );
    expect(entry).toMatchObject({
      action: "UPDATE",
      userId: SYSTEM_USER_ID,
      writerUserId: SYSTEM_USER_ID,
      entityName: user.email,
    });
    expect(entry?.metadata).toEqual({
      action: "token_reuse_detected",
      credential: "authorization_code",
      clientId: client.clientId,
      authCodeId: authCode.id,
      sessionIds: [sidOf(tokens.access_token)],
      revokedAccessTokens: 1,
      revokedRefreshTokens: 1,
    });
    await expectRevokedEvent(user.id);
  });

  it("audits a replayed refresh token past the grace", async () => {
    const { user, tokens } = await signIn();
    const rotated = await refresh(tokens.refresh_token);
    expect(rotated.status).toBe(HTTP_STATUS.OK);
    const successor = (await rotated.json()) as Tokens;
    // Out of the race window: a replay now is theft, not a second tab.
    await prisma.refreshToken.update({
      where: { id: sidOf(tokens.access_token) },
      data: { rotatedAt: new Date(Date.now() - 60_000) },
    });

    expect((await refresh(tokens.refresh_token)).status).toBe(
      HTTP_STATUS.BAD_REQUEST
    );

    const entry = (await entriesOf(user.id)).find(
      (e) =>
        (e.metadata as { action?: string } | null)?.action ===
        "token_reuse_detected"
    );
    expect(entry).toMatchObject({ action: "UPDATE", userId: SYSTEM_USER_ID });
    expect(entry?.metadata).toMatchObject({
      credential: "refresh_token",
      clientId: client.clientId,
      sessionIds: [sidOf(successor.access_token)],
      revokedRefreshTokens: 1,
    });
    await expectRevokedEvent(user.id);
  });
});

describe("POST /oauth/revoke", () => {
  it("audits a refresh-token revoke as a LOGOUT and emits it, once", async () => {
    const { user, tokens } = await signIn();
    const sid = sidOf(tokens.access_token);

    expect((await revoke(tokens.refresh_token)).status).toBe(HTTP_STATUS.OK);

    const logouts = (await entriesOf(user.id)).filter(
      (e) => e.action === "LOGOUT"
    );
    expect(logouts).toHaveLength(1);
    expect(logouts[0]).toMatchObject({ userId: user.id });
    expect(logouts[0].metadata).toMatchObject({
      action: "sessions_revoked",
      method: "revoke",
      sessionIds: [sid],
    });
    await expectRevokedEvent(user.id);

    // Nothing left to revoke: nothing more recorded.
    expect((await revoke(tokens.refresh_token)).status).toBe(HTTP_STATUS.OK);
    expect(
      (await entriesOf(user.id)).filter((e) => e.action === "LOGOUT")
    ).toHaveLength(1);
  });

  it("audits an access-token revoke in its transaction, once", async () => {
    const { user, tokens } = await signIn();
    const { jti } = decodeJwt(tokens.access_token) as unknown as {
      jti: string;
    };

    expect((await revoke(tokens.access_token)).status).toBe(HTTP_STATUS.OK);
    expect(
      (await prisma.accessToken.findUniqueOrThrow({ where: { jti } })).revokedAt
    ).not.toBeNull();
    const logouts = (await entriesOf(user.id)).filter(
      (e) => e.action === "LOGOUT"
    );
    expect(logouts).toHaveLength(1);
    expect(logouts[0].metadata).toEqual({
      action: "token_revoked",
      method: "revoke",
      tokenType: "access_token",
      jti,
      clientId: client.clientId,
    });

    expect((await revoke(tokens.access_token)).status).toBe(HTTP_STATUS.OK);
    expect(
      (await entriesOf(user.id)).filter((e) => e.action === "LOGOUT")
    ).toHaveLength(1);
  });
});

describe("POST /oauth/end-session", () => {
  const endSession = (jar: CookieJar, idTokenHint: string) =>
    fetch(`${BASE_URL}/oauth/end-session`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookieHeader(jar),
      },
      body: new URLSearchParams({ id_token_hint: idTokenHint }),
    });

  it("emits the revocation beside LOGOUT, and records nothing when already signed out", async () => {
    const { user, jar, tokens } = await signIn();

    expect((await endSession(jar, tokens.id_token)).status).toBe(
      HTTP_STATUS.OK
    );
    expect(
      (await entriesOf(user.id)).filter((e) => e.action === "LOGOUT")
    ).toHaveLength(1);
    await expectRevokedEvent(user.id);
    const events = await revokedEventsFor(user.id);

    // The same hint again, the session it names already ended.
    expect((await endSession(new Map(), tokens.id_token)).status).toBe(
      HTTP_STATUS.OK
    );
    expect(
      (await entriesOf(user.id)).filter((e) => e.action === "LOGOUT")
    ).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(await revokedEventsFor(user.id)).toBe(events);
  });
});

describe("a browser signed in as another user", () => {
  it("audits and emits the previous user's sessions it ends", async () => {
    const first = await signIn();
    const second = await createTestUser();

    // prompt=login: the browser's live SSO session is not continued.
    const pkce = newPkce();
    const params = {
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: REDIRECT_URI,
      state: pkce.state,
      scope: SCOPE,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      prompt: "login",
    };
    const jar = first.jar;
    absorbCookies(
      jar,
      await fetch(
        `${BASE_URL}/oauth/authorize?${new URLSearchParams(params)}`,
        {
          redirect: "manual",
          headers: { Cookie: cookieHeader(jar) },
        }
      )
    );
    const submit = await fetch(`${BASE_URL}/oauth/authorize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader(jar),
      },
      body: JSON.stringify({
        ...params,
        email: second.email,
        password: second.plainPassword,
      }),
    });
    absorbCookies(jar, submit);
    expect(submit.status).toBe(HTTP_STATUS.OK);
    const { redirect_url } = (await submit.json()) as { redirect_url: string };
    const session = new URL(redirect_url).searchParams.get("session");
    const consent = await fetch(`${BASE_URL}/oauth/consent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader(jar),
      },
      body: JSON.stringify({ session_token: session, approved: true }),
    });
    expect(consent.status).toBe(HTTP_STATUS.OK);

    const entry = (await entriesOf(first.user.id)).find(
      (e) =>
        (e.metadata as { action?: string } | null)?.action ===
        "sessions_revoked"
    );
    expect(entry).toMatchObject({ action: "UPDATE", userId: SYSTEM_USER_ID });
    expect(entry?.metadata).toMatchObject({
      sessionIds: [sidOf(first.tokens.access_token)],
    });
    expect(
      (entry?.metadata as { ssoSessionIds: string[] }).ssoSessionIds
    ).toHaveLength(1);
    await expectRevokedEvent(first.user.id);
  });
});
