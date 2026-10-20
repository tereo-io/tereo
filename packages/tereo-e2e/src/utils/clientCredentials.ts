import type { APIRequestContext, Locator } from "@playwright/test";
import { expect } from "@playwright/test";

export interface Credentials {
  clientId: string;
  clientSecret: string;
}

/**
 * The client ID and secret a credentials dialog shows once. The secret is the
 * masked value, so this reveals it first; the client ID is the first value.
 */
export async function readCredentials(dialog: Locator): Promise<Credentials> {
  const values = dialog.getByRole("code");
  await expect(values.first()).toBeVisible();
  const masked = (await values.allTextContents()).findIndex((text) =>
    /^•+$/.test(text.trim())
  );
  expect(masked, "a masked secret in the dialog").toBeGreaterThan(-1);
  await dialog.getByRole("button", { name: "Reveal" }).click();
  await expect(values.nth(masked)).not.toHaveText(/^•+$/);
  return {
    clientId: (await values.first().textContent())!.trim(),
    clientSecret: (await values.nth(masked).textContent())!.trim(),
  };
}

const basic = ({ clientId, clientSecret }: Credentials) =>
  `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;

/** A client_credentials token request, as a service or integration makes it. */
export async function clientCredentialsGrant(
  request: APIRequestContext,
  credentials: Credentials
) {
  return request.post("/oauth/token", {
    headers: { Authorization: basic(credentials) },
    form: { grant_type: "client_credentials" },
  });
}

/**
 * Whether core accepts a login client's secret. A login client has no
 * client_credentials grant, so this sends an authorization_code request with
 * a code that was never issued: core authenticates the client before it
 * looks at the code, so a good secret gets `invalid_grant`, a bad one
 * `invalid_client`.
 */
export async function loginClientSecretWorks(
  request: APIRequestContext,
  credentials: Credentials,
  redirectUri: string
): Promise<boolean> {
  const response = await request.post("/oauth/token", {
    headers: { Authorization: basic(credentials) },
    form: {
      grant_type: "authorization_code",
      code: "never-issued",
      redirect_uri: redirectUri,
      code_verifier: "e2e-verifier-".padEnd(64, "0"),
    },
  });
  const body = (await response.json()) as { error?: string };
  if (body.error === "invalid_grant") return true;
  if (body.error === "invalid_client") return false;
  throw new Error(
    `Unexpected token response ${response.status()}: ${JSON.stringify(body)}`
  );
}

/** Exchanges an authorization code, with Basic client authentication. */
export async function exchangeCode(
  request: APIRequestContext,
  credentials: Credentials,
  input: { code: string; redirectUri: string; codeVerifier: string }
) {
  return request.post("/oauth/token", {
    headers: { Authorization: basic(credentials) },
    form: {
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    },
  });
}

interface CreatedWithCredentials {
  id: string;
  name: string;
  slug: string;
  credentials: Credentials;
}

async function created<T>(
  response: Awaited<ReturnType<APIRequestContext["post"]>>
): Promise<T> {
  if (!response.ok()) {
    throw new Error(
      `${response.url()} → ${response.status()}: ${await response.text()}`
    );
  }
  return (await response.json()) as T;
}

/** `POST /v1/admin/services`, over the admin's API context. */
export const createService = async (
  api: APIRequestContext,
  input: { name: string; slug: string }
) =>
  created<CreatedWithCredentials>(
    await api.post("admin/services", { data: input })
  );

/** `POST /v1/admin/integrations` (a platform integration). */
export const createIntegration = async (
  api: APIRequestContext,
  input: { name: string; slug: string }
) =>
  created<CreatedWithCredentials>(
    await api.post("admin/integrations", { data: input })
  );

export interface CreatedClient {
  id: string;
  clientId: string;
  clientSecret: string;
  name: string;
}

/** `POST /v1/admin/clients`: a confidential login client. */
export const createLoginClient = async (
  api: APIRequestContext,
  input: {
    name: string;
    redirectUris: string[];
    scopes?: string[];
    consentRequired?: boolean;
  }
) =>
  created<CreatedClient>(
    await api.post("admin/clients", {
      data: {
        clientType: "confidential",
        grantTypes: ["authorization_code"],
        scopes: ["openid", "profile", "email"],
        ...input,
      },
    })
  );
