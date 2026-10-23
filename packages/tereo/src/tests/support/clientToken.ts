import { CORE_URL } from "./coreUrl.js";
import { expect } from "vitest";

export interface Credentials {
  clientId: string;
  clientSecret: string;
}

export const clientCredentialsToken = async ({
  clientId,
  clientSecret,
}: Credentials) => {
  const response = await fetch(`${CORE_URL}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const body = (await response.json()) as { access_token?: string };
  return { status: response.status, token: body.access_token ?? null };
};

export const tokenFor = async (service: { credentials: Credentials }) => {
  const { status, token } = await clientCredentialsToken(service.credentials);
  expect(status).toBe(200);
  return token!;
};

export const tokenResponse = (clientId: string, clientSecret: string) =>
  fetch(`${CORE_URL}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

/** A provisioned service document: its client id is on `service`, its secret beside it. */
export const serviceToken = (d: {
  service: { clientId: string };
  plainSecret: string;
}) =>
  tokenFor({
    credentials: { clientId: d.service.clientId, clientSecret: d.plainSecret },
  });
