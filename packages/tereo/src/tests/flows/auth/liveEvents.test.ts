// @module-tag int
// @module-tag auth
import { ensurePermission, makeServiceOf } from "../../support/testService.js";
import { BASE_URL, HTTP_STATUS } from "../../support/auth/constants.js";
import { createTestClient } from "../../support/auth/clients.js";
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../../../utils/db/prisma.js";
import {
  ensureTestOrganization,
  getTestPrincipalToken,
} from "../../support/principals.js";
import {
  connect,
  received,
  signInFor,
  stillOpen,
} from "../../support/socket.js";

/**
 * A client with `liveEvents` gets its tokens onto the socket without core
 * scopes; the token stays `none` for everything else.
 */

const REDIRECT_URI = "http://localhost:3000/live-events-callback";

type Client = Awaited<ReturnType<typeof createTestClient>>;

let live: Client;
let account: Client;
const signInLive = signInFor(() => live, REDIRECT_URI);
const signInAccount = signInFor(() => account, REDIRECT_URI);

const setLiveEvents = (client: Client, liveEvents: boolean) =>
  prisma.oAuthClient.update({ where: { id: client.id }, data: { liveEvents } });

const replaceRoles = async (userId: string) => {
  const res = await fetch(`${BASE_URL}/v1/admin/users/${userId}/roles`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${await getTestPrincipalToken({
        permissions: ["users.write"],
      })}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ roleIds: [] }),
  });
  expect(res.status).toBe(HTTP_STATUS.OK);
};

beforeAll(async () => {
  live = await createTestClient({ redirectUris: [REDIRECT_URI] });
  await setLiveEvents(live, true);
  account = await createTestClient({ redirectUris: [REDIRECT_URI] });
});

describe("a liveEvents client's token without core scopes", () => {
  it("is admitted to the socket and gets a permission change", async () => {
    const { user, accessToken } = await signInLive("openid");
    const socket = connect(accessToken);
    try {
      expect(await socket.connected).toBeNull();
      await replaceRoles(user.id);
      await received(socket, "auth:permissions:changed");
    } finally {
      socket.close();
    }
  });

  it("still lets a service in the audience introspect the service's permissions", async () => {
    const service = await createTestClient({
      clientType: "confidential",
      scopes: [],
    });
    const slug = await makeServiceOf(service.id);
    const client = await createTestClient({
      redirectUris: [REDIRECT_URI],
      audience: [slug],
    });
    await setLiveEvents(client, true);
    const permission = `${slug}.things.read`;
    await ensurePermission(permission);
    const { user, accessToken } = await signInFor(
      () => client,
      REDIRECT_URI
    )("openid");
    await getTestPrincipalToken({ userId: user.id, permissions: [permission] });

    const res = await fetch(`${BASE_URL}/oauth/introspect`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(
          `${service.clientId}:${service.plainSecret}`
        ).toString("base64")}`,
      },
      body: new URLSearchParams({ token: accessToken }),
    });
    const body = (await res.json()) as {
      active: boolean;
      permissions?: string[];
    };
    expect(body.active).toBe(true);
    expect(body.permissions).toContain(permission);
  });

  it("is still refused on /v1/account", async () => {
    const { accessToken } = await signInLive("openid");
    const res = await fetch(`${BASE_URL}/v1/account/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(res.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_token"
    );
  });

  it("is refused for a client without liveEvents", async () => {
    const plain = await createTestClient({ redirectUris: [REDIRECT_URI] });
    const { accessToken } = await signInFor(
      () => plain,
      REDIRECT_URI
    )("openid");
    const socket = connect(accessToken);
    try {
      expect(await socket.connected).toBe(
        "This token is not issued for core's API"
      );
    } finally {
      socket.close();
    }
  });

  it("is refused at new handshakes once liveEvents is turned off", async () => {
    const client = await createTestClient({ redirectUris: [REDIRECT_URI] });
    await setLiveEvents(client, true);
    const { accessToken } = await signInFor(
      () => client,
      REDIRECT_URI
    )("openid");
    const first = connect(accessToken);
    try {
      expect(await first.connected).toBeNull();
    } finally {
      first.close();
    }

    await setLiveEvents(client, false);
    const second = connect(accessToken);
    try {
      expect(await second.connected).toBe(
        "This token is not issued for core's API"
      );
    } finally {
      second.close();
    }
  });

  it("does not put the socket in the account room", async () => {
    const { user, accessToken } = await signInLive("openid");
    const { accessToken: accountToken } = await signInAccount(
      "openid core:account",
      user
    );
    const socket = connect(accessToken);
    const control = connect(accountToken);
    try {
      expect(await socket.connected).toBeNull();
      expect(await control.connected).toBeNull();
      const orgId = await ensureTestOrganization(`live-events-${user.id}`);
      const added = await fetch(
        `${BASE_URL}/v1/admin/organizations/${orgId}/members`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${await getTestPrincipalToken({
              permissions: ["organizations.write"],
            })}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ userId: user.id, memberRole: "member" }),
        }
      );
      expect(added.status).toBe(HTTP_STATUS.CREATED);
      await received(control, "auth:organization:changed");
      expect(await stillOpen(socket, 800)).toBe(true);
      expect(socket.events.map((e) => e.name)).not.toContain(
        "auth:organization:changed"
      );
    } finally {
      socket.close();
      control.close();
    }
  });
});
