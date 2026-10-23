// @module-tag int
// @module-tag auth
import { BASE_URL, HTTP_STATUS } from "../../../support/auth/constants.js";
import { createTestClient } from "../../../support/auth/clients.js";
import { createTestUser } from "../../../support/auth/users.js";
import { codeFlowSignIn } from "../../../support/auth/login.js";
import { decodeJwt } from "../../../support/auth/tokens.js";
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../../../../utils/db/prisma.js";
import {
  DEFAULT_ORGANIZATION_ID,
  SYSTEM_USER_ID,
} from "../../../../definitions/index.js";
import {
  absorbCookies,
  cookieHeader,
  newPkce,
} from "../../../support/browserLogin.js";
import {
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../../../support/webhooks.js";

const REDIRECT_URI = "http://localhost:3000/token-lifecycle-audit-callback";
const SCOPE = "openid offline_access";

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

const { signIn } = codeFlowSignIn(() => client, REDIRECT_URI, SCOPE);

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
