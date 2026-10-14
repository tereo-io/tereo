import { LOGIN_CLIENT, loginClientConfig } from "../../definitions/index.js";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { getTestPrincipalToken } from "../utils/principals.js";
import { ensureLoginClient } from "../../utils/loginClient.js";
import { browserLogin } from "../utils/browserLogin.js";
import { prisma } from "../../utils/db/prisma.js";
import env from "../../env.js";
import {
  BASE_URL,
  HTTP_STATUS,
  createTestClient,
  createTestUser,
} from "./utils/test-helpers.js";

type Client = { clientId: string; redirectUris: string[] };

const exchange = async (client: Client) => {
  const user = await createTestUser();
  const redirectUri = client.redirectUris[0];
  const { code, verifier } = await browserLogin({
    clientId: client.clientId,
    redirectUri,
    scope: "openid offline_access",
    email: user.email,
    password: user.plainPassword,
  });
  const res = await fetch(`${BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: client.clientId,
      code_verifier: verifier,
    }),
  });
  expect(res.status).toBe(HTTP_STATUS.OK);
  return (await res.json()) as { access_token: string; refresh_token?: string };
};

describe("refresh tokens at the code exchange", () => {
  it("are issued to a client with the refresh_token grant", async () => {
    const client = await createTestClient({
      grantTypes: ["authorization_code", "refresh_token"],
    });
    expect((await exchange(client)).refresh_token).toBeTruthy();
  });

  it("are not issued to a client without it", async () => {
    const client = await createTestClient({
      grantTypes: ["authorization_code"],
    });
    const tokens = await exchange(client);
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeUndefined();
  });

  it("are issued to core's UI", async () => {
    const ui = await prisma.oAuthClient.findUniqueOrThrow({
      where: { clientId: LOGIN_CLIENT.clientId },
    });
    expect(ui.grantTypes).toContain("refresh_token");
    expect((await exchange(ui)).refresh_token).toBeTruthy();
  });
});

describe("the admin UI's login client", () => {
  let adminToken: string;
  let loginClientId: string;

  beforeAll(async () => {
    adminToken = await getTestPrincipalToken({
      permissions: ["clients.admin"],
    });
    loginClientId = (
      await prisma.oAuthClient.findUniqueOrThrow({
        where: { clientId: LOGIN_CLIENT.clientId },
      })
    ).id;
  });

  const patch = (body: Record<string, unknown>) =>
    fetch(`${BASE_URL}/v1/admin/clients/${loginClientId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

  it("has its redirect URI derived from UI_BASE_URL", async () => {
    const client = await prisma.oAuthClient.findUniqueOrThrow({
      where: { id: loginClientId },
    });
    expect(client.redirectUris).toEqual([`${env.UI_BASE_URL}/callback`]);
  });

  it("refuses an edit of its redirect URIs, grant types or type with 409", async () => {
    for (const body of [
      { redirectUris: ["https://evil.example/callback"] },
      { grantTypes: ["authorization_code"] },
      { clientType: "confidential" },
    ]) {
      const res = await patch(body);
      expect(res.status, JSON.stringify(body)).toBe(HTTP_STATUS.CONFLICT);
    }
    const client = await prisma.oAuthClient.findUniqueOrThrow({
      where: { id: loginClientId },
    });
    expect(client.redirectUris).toEqual([`${env.UI_BASE_URL}/callback`]);
  });

  it("is brought back in line with UI_BASE_URL at start", async () => {
    await prisma.oAuthClient.update({
      where: { id: loginClientId },
      data: {
        redirectUris: ["http://old-ui.example/callback"],
        grantTypes: ["authorization_code"],
        scopes: ["openid"],
      },
    });

    await ensureLoginClient();

    const client = await prisma.oAuthClient.findUniqueOrThrow({
      where: { id: loginClientId },
    });
    const want = loginClientConfig(env.UI_BASE_URL);
    expect(client.redirectUris).toEqual(want.redirectUris);
    expect([...client.grantTypes].sort()).toEqual([...want.grantTypes].sort());
    expect(client.scopes).toEqual(expect.arrayContaining(want.scopes));
  });

  describe("redirect URIs at start", () => {
    const callback = `${env.UI_BASE_URL}/callback`;
    const otherLocalUi = "http://localhost:4999/callback";

    const setRedirectUris = (redirectUris: string[]) =>
      prisma.oAuthClient.update({
        where: { id: loginClientId },
        data: { redirectUris },
      });
    const redirectUris = async () =>
      (
        await prisma.oAuthClient.findUniqueOrThrow({
          where: { id: loginClientId },
        })
      ).redirectUris;

    afterEach(() => setRedirectUris([callback]));

    it("outside production, add this core's callback and keep another local UI's", async () => {
      await setRedirectUris([otherLocalUi]);

      await ensureLoginClient({ production: false });

      expect(await redirectUris()).toEqual([callback, otherLocalUi]);
    });

    it("outside production, drop a non-loopback callback", async () => {
      await setRedirectUris([callback, "https://staging.example/callback"]);

      await ensureLoginClient({ production: false });

      expect(await redirectUris()).toEqual([callback]);
    });

    it("in production, are exactly this core's callback", async () => {
      await setRedirectUris([callback, otherLocalUi]);

      await ensureLoginClient({ production: true });

      expect(await redirectUris()).toEqual([callback]);
    });
  });
});
