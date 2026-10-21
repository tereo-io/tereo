import { TEST_PASSWORD } from "../../fixtures/coreApi.js";
import { expect, test } from "../../fixtures/index.js";
import { signedOutPage } from "../../utils/signIn.js";
import { createHash, randomBytes } from "crypto";
import type { Page } from "@playwright/test";
import {
  createLoginClient,
  exchangeCode,
} from "../../utils/clientCredentials.js";

const base64url = (buffer: Buffer) => buffer.toString("base64url");

/**
 * Starts a third-party app's sign-in with PKCE, as the app would, and signs
 * in on core's login page. A new client has no session of its own, so core
 * always asks for the password before the consent screen.
 */
async function startAppSignIn(
  page: Page,
  input: { clientId: string; redirectUri: string; email: string }
) {
  const codeVerifier = base64url(randomBytes(32));
  const state = base64url(randomBytes(16));
  const authorize = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: "openid profile email",
    state,
    code_challenge: base64url(
      createHash("sha256").update(codeVerifier).digest()
    ),
    code_challenge_method: "S256",
  });
  await page.goto(`/oauth/authorize?${authorize.toString()}`);
  await expect(page).toHaveURL(/\/login\?/);
  await page.getByLabel("Email").fill(input.email);
  await page
    .getByRole("textbox", { name: "Password", exact: true })
    .fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(
    page.getByRole("heading", { name: "Authorization Request" })
  ).toBeVisible();
  return { codeVerifier, state };
}

/**
 * The app's redirect URI is never served (`.invalid`): the test reads the
 * request the browser makes to it, which carries what core sent back.
 */
const appRedirect = (page: Page, redirectUri: string) =>
  page
    .waitForRequest((request) => request.url().startsWith(redirectUri))
    .then((request) => new URL(request.url()).searchParams);

test("a user approves a third-party app, which gets a code it can redeem", async ({
  browser,
  api,
  request,
  uid,
}) => {
  const redirectUri = `https://${uid("app")}.e2e.invalid/callback`;
  const client = await createLoginClient(api.request, {
    name: `Acme ${uid("consent")}`,
    redirectUris: [redirectUri],
  });
  const user = await api.createUser({ email: `${uid("consent")}@e2e.test` });

  const page = await signedOutPage(browser);
  const { codeVerifier, state } = await startAppSignIn(page, {
    clientId: client.clientId,
    redirectUri,
    email: user.email,
  });
  await expect(page.getByText(client.name)).toBeVisible();
  await expect(page.getByText(user.email)).toBeVisible();
  for (const scope of [
    "OpenID Connect",
    "Profile Information",
    "Email Address",
  ])
    await expect(page.getByText(scope, { exact: true })).toBeVisible();

  const redirected = appRedirect(page, redirectUri);
  await page.getByRole("button", { name: "Allow" }).click();
  const params = await redirected;
  expect(params.get("state")).toBe(state);
  const code = params.get("code");
  expect(code).toBeTruthy();

  // The app redeems the code with its secret and reads who signed in.
  const token = await exchangeCode(
    request,
    { clientId: client.clientId, clientSecret: client.clientSecret },
    { code: code!, redirectUri, codeVerifier }
  );
  expect(token.status()).toBe(200);
  const { access_token } = (await token.json()) as { access_token: string };
  const userinfo = await request.get("/oauth/userinfo", {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  expect(userinfo.status()).toBe(200);
  expect(((await userinfo.json()) as { email: string }).email).toBe(user.email);

  await page.context().close();
});

test("a user denies a third-party app, which gets access_denied", async ({
  browser,
  api,
  uid,
}) => {
  const redirectUri = `https://${uid("app")}.e2e.invalid/callback`;
  const client = await createLoginClient(api.request, {
    name: `Acme ${uid("deny")}`,
    redirectUris: [redirectUri],
  });
  const user = await api.createUser({ email: `${uid("deny")}@e2e.test` });

  const page = await signedOutPage(browser);
  const { state } = await startAppSignIn(page, {
    clientId: client.clientId,
    redirectUri,
    email: user.email,
  });

  const redirected = appRedirect(page, redirectUri);
  await page.getByRole("button", { name: "Deny" }).click();
  const params = await redirected;
  expect(params.get("error")).toBe("access_denied");
  expect(params.get("state")).toBe(state);
  expect(params.get("code")).toBeNull();

  await page.context().close();
});
