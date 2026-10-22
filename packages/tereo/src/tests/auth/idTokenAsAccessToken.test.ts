import { describe, it, expect, beforeAll } from "vitest";
import { generateIdToken } from "../../utils/tokens.js";
import {
  BASE_URL,
  HTTP_STATUS,
  createTestClient,
  createTestUser,
  getAccessTokenForUser,
} from "../support/auth.js";

/**
 * ID tokens are signed with the access tokens' key and issuer, but carry no
 * jti, client_id or scope. None of the endpoints that verify an access token
 * may take one for an access token.
 */

let client: Awaited<ReturnType<typeof createTestClient>>;

beforeAll(async () => {
  client = await createTestClient();
});

const idTokenFor = (userId: string) =>
  generateIdToken({ subject: userId, clientId: client.clientId }).token;

describe("an ID token presented as an access token", () => {
  it("revoking it at /oauth/revoke leaves other users' access tokens alone", async () => {
    const victim = await createTestUser();
    const victimToken = await getAccessTokenForUser(victim, client);
    const holder = await createTestUser();

    const revoke = await fetch(`${BASE_URL}/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: client.clientId,
        token: idTokenFor(holder.id),
      }),
    });
    expect(revoke.status).toBe(HTTP_STATUS.OK);

    const me = await fetch(`${BASE_URL}/v1/account/me`, {
      headers: { Authorization: `Bearer ${victimToken}` },
    });
    expect(me.status).toBe(HTTP_STATUS.OK);
  });

  it("is refused with 401 as a bearer token", async () => {
    const user = await createTestUser();
    const res = await fetch(`${BASE_URL}/v1/account/me`, {
      headers: { Authorization: `Bearer ${idTokenFor(user.id)}` },
    });
    expect(res.status).toBe(HTTP_STATUS.UNAUTHORIZED);
  });

  it("is inactive at /oauth/userinfo", async () => {
    const user = await createTestUser();
    const res = await fetch(`${BASE_URL}/oauth/userinfo`, {
      headers: { Authorization: `Bearer ${idTokenFor(user.id)}` },
    });
    expect(res.status).toBe(HTTP_STATUS.UNAUTHORIZED);
  });
});
