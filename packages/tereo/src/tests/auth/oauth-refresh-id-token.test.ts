import { browserLogin } from "../support/browserLogin.js";
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import {
  BASE_URL,
  createTestClient,
  createTestUser,
  decodeJwt,
} from "../support/auth.js";

/**
 * OIDC Core 12.2: a refresh of an openid grant returns a fresh ID token for
 * the same login, so a client always holds a usable logout hint.
 */

const REDIRECT_URI = "http://localhost:3000/refresh-id-token-callback";

let client: Awaited<ReturnType<typeof createTestClient>>;

interface Tokens {
  access_token: string;
  refresh_token: string;
  id_token?: string;
}

const token = async (params: Record<string, string>) => {
  const res = await fetch(`${BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: client.clientId, ...params }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Tokens;
};

const login = async (scope: string, nonce?: string) => {
  const user = await createTestUser();
  const { jar, code, verifier } = await browserLogin({
    clientId: client.clientId,
    redirectUri: REDIRECT_URI,
    scope,
    nonce,
    email: user.email,
    password: user.plainPassword,
  });
  const tokens = await token({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });
  return { user, jar, tokens };
};

beforeAll(async () => {
  client = await createTestClient({ redirectUris: [REDIRECT_URI] });
});

describe("refresh_token grant ID token", () => {
  it("returns a fresh ID token with the login's sid and auth_time, and no nonce", async () => {
    const { user, tokens } = await login(
      "openid profile email offline_access",
      "login-nonce"
    );
    const original = decodeJwt(tokens.id_token!) as unknown as Record<
      string,
      unknown
    >;
    expect(original.nonce).toBe("login-nonce");

    // Distinct iat from the original.
    await new Promise((r) => setTimeout(r, 1100));
    const refreshed = await token({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    });
    expect(refreshed.id_token).toBeTruthy();
    const claims = decodeJwt(refreshed.id_token!) as unknown as Record<
      string,
      unknown
    >;

    expect(claims.sub).toBe(user.id);
    expect(claims.aud).toBe(client.clientId);
    expect(claims.sid).toBe(original.sid);
    expect(claims.sid).toBeTruthy();
    expect(claims.auth_time).toBe(original.auth_time);
    expect(claims.amr).toEqual(original.amr);
    expect(claims.acr).toBe(original.acr);
    expect(claims.email).toBe(user.email);
    expect(claims).not.toHaveProperty("nonce");
    expect(claims.iat as number).toBeGreaterThan(original.iat as number);
    expect(claims.at_hash).not.toBe(original.at_hash);

    // It works as the logout hint, ending the login's SSO session.
    const res = await fetch(
      `${BASE_URL}/oauth/end-session?${new URLSearchParams({
        id_token_hint: refreshed.id_token!,
      })}`,
      { redirect: "manual" }
    );
    expect(res.status).toBe(302);
    expect(
      await prisma.userSession.count({ where: { id: claims.sid as string } })
    ).toBe(0);
  });

  it("returns no ID token for a grant without openid", async () => {
    const { tokens } = await login("profile offline_access");
    expect(tokens.id_token).toBeUndefined();
    const refreshed = await token({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    });
    expect(refreshed.id_token).toBeUndefined();
  });

  it("returns none when the refresh narrows the scope to drop openid", async () => {
    const { tokens } = await login("openid profile offline_access");
    const refreshed = await token({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      scope: "profile",
    });
    expect(refreshed.id_token).toBeUndefined();
  });
});
