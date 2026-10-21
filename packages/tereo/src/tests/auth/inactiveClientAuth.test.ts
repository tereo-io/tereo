import { describe, it, expect, beforeEach } from "vitest";
import { makeServiceOf } from "../utils/testService.js";
import { prisma } from "../../utils/db/prisma.js";
import {
  BASE_URL,
  HTTP_STATUS,
  OAUTH_ERRORS,
  createTestClient,
  createTestUser,
  type TokenResponse,
} from "./utils/test-helpers.js";

/**
 * A deactivated service's or integration's secret authenticates nowhere:
 * not at /oauth/token, and not at /oauth/introspect, /oauth/check-permission
 * or /oauth/revoke either.
 */

type Client = Awaited<ReturnType<typeof createTestClient>>;

const basic = (client: Client) =>
  `Basic ${Buffer.from(`${client.clientId}:${client.plainSecret}`).toString(
    "base64"
  )}`;

const post = (client: Client, path: string, body: Record<string, unknown>) =>
  fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: basic(client),
    },
    body: JSON.stringify(body),
  });

const serviceToken = async (client: Client): Promise<string> => {
  const res = await post(client, "/oauth/token", {
    grant_type: "client_credentials",
  });
  expect(res.status).toBe(HTTP_STATUS.OK);
  return ((await res.json()) as TokenResponse).access_token!;
};

const expectInvalidClient = async (res: Response) => {
  expect(res.status).toBe(HTTP_STATUS.UNAUTHORIZED);
  expect(((await res.json()) as { error: string }).error).toBe(
    OAUTH_ERRORS.INVALID_CLIENT
  );
};

describe.each([
  ["service and account deactivated", { service: false, account: false }],
  ["service deactivated", { service: false, account: true }],
  ["account deactivated", { service: true, account: false }],
])("a client whose %s", (_label, active) => {
  let client: Client;
  let token: string;
  let userId: string;

  beforeEach(async () => {
    client = await createTestClient({
      clientType: "confidential",
      grantTypes: ["client_credentials"],
      scopes: [],
    });
    await makeServiceOf(client.id);
    token = await serviceToken(client);
    userId = (await createTestUser()).id;

    // Before deactivation, every endpoint accepts the secret.
    expect((await post(client, "/oauth/introspect", { token })).status).toBe(
      HTTP_STATUS.OK
    );

    await prisma.service.update({
      where: { clientId: client.id },
      data: { isActive: active.service },
    });
    await prisma.user.update({
      where: { oauthClientId: client.id },
      data: { isActive: active.account },
    });
  });

  it("is refused at /oauth/introspect", async () => {
    await expectInvalidClient(
      await post(client, "/oauth/introspect", { token })
    );
  });

  it("is refused at /oauth/check-permission", async () => {
    await expectInvalidClient(
      await post(client, "/oauth/check-permission", {
        user_id: userId,
        permission: "webhooks.read",
      })
    );
    await expectInvalidClient(
      await post(client, "/oauth/check-permission/batch", {
        user_id: userId,
        permissions: ["webhooks.read"],
      })
    );
  });

  it("is refused at /oauth/revoke", async () => {
    await expectInvalidClient(await post(client, "/oauth/revoke", { token }));
  });
});
