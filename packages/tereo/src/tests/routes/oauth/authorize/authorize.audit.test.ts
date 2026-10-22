// @module-tag int
// @module-tag auth
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../../../../utils/db/prisma.js";
import {
  DEFAULT_ORGANIZATION_ID,
  SYSTEM_USER_ID,
} from "../../../../definitions/index.js";
import {
  absorbCookies,
  browserLogin,
  cookieHeader,
  newPkce,
  type CookieJar,
} from "../../../support/browserLogin.js";
import {
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../../../support/webhooks.js";
import {
  BASE_URL,
  HTTP_STATUS,
  createTestClient,
  createTestUser,
  decodeJwt,
} from "../../../support/auth.js";

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

describe("POST /oauth/authorize", () => {
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
      const { redirect_url } = (await submit.json()) as {
        redirect_url: string;
      };
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
});
