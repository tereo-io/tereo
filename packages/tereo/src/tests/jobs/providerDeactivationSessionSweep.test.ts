// @module-tag int
// @module-tag auth
// @module-tag job

import { ensureDefaultOrganization } from "../../utils/defaultOrganization.js";
import { cookieHeader, type CookieJar } from "../support/browserLogin.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getTestPrincipalToken } from "../support/principals.js";
import { getAccessTokenForUser } from "../support/auth/login.js";
import { createTestClient } from "../support/auth/clients.js";
import { generateUniqueId } from "../support/auth/crypto.js";
import { upstreamLogin } from "../support/upstreamLogin.js";
import { createTestUser } from "../support/auth/users.js";
import { prisma } from "../../utils/db/prisma.js";
import { CORE_URL } from "../support/coreUrl.js";
import db from "../../utils/db/index.js";
import { randomUUID } from "node:crypto";
import {
  closeProviderDeactivationSessionSweepQueue,
  getProviderDeactivationSessionSweepQueue,
  processProviderDeactivationSessionSweep,
  type ProviderDeactivationSessionSweepJobData,
} from "../../jobs/providerDeactivationSessionSweep.js";
import {
  startFakeOidcProvider,
  FakeOidcProvider,
} from "../support/fakeOidcProvider.js";
import {
  DEFAULT_ORGANIZATION_ID,
  SYSTEM_USER_ID,
} from "../../definitions/index.js";
import {
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../support/webhooks.js";

const BASE = `${CORE_URL}/v1/admin/identity-providers`;
const REDIRECT_URI = "http://localhost:3000/callback";
const SCOPE = "openid profile email offline_access";

interface Provider {
  id: string;
  slug: string;
}

let fake: FakeOidcProvider;
let eventsEndpointId: string;
let writeToken: string;
let client: Awaited<ReturnType<typeof createTestClient>>;

beforeAll(async () => {
  fake = await startFakeOidcProvider();
  writeToken = await getTestPrincipalToken({
    permissions: ["identity-providers.write"],
  });
  client = await createTestClient();
  const endpoint = await createTestWebhookEndpoint(
    await getCoreEventSubscriberToken(DEFAULT_ORGANIZATION_ID),
    { eventTypes: ["auth.user.sessions-revoked"] }
  );
  eventsEndpointId = endpoint.id;
  // Called here, outside the server: what the sweep emits needs the cache.
  await ensureDefaultOrganization();
});

afterAll(async () => {
  await closeProviderDeactivationSessionSweepQueue();
  await fake.close();
});

const call = (method: string, path: string, body?: unknown) =>
  fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${writeToken}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const newProvider = async () => {
  const response = await call("POST", "", {
    slug: `p-${generateUniqueId().toLowerCase()}`.slice(0, 40),
    displayName: "Fake IdP",
    kind: "oidc",
    issuer: fake.issuer,
    clientId: fake.clientId,
    clientSecret: fake.clientSecret,
  });
  expect(response.status).toBe(201);
  return (await response.json()) as Provider;
};

const link = async (userId: string, provider: Provider) => {
  const subject = `sub-${randomUUID()}`;
  await prisma.userIdentity.create({
    data: { userId, providerId: provider.id, subject },
  });
  return subject;
};

const codeFrom = async (jar: CookieJar, location: URL) => {
  if (location.pathname !== "/consent") {
    return location.searchParams.get("code");
  }
  const res = await fetch(`${CORE_URL}/oauth/consent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieHeader(jar) },
    body: JSON.stringify({
      session_token: location.searchParams.get("session"),
      approved: true,
    }),
  });
  expect(res.status).toBe(200);
  const { redirect_url } = (await res.json()) as { redirect_url: string };
  return new URL(redirect_url).searchParams.get("code");
};

/** Signs the user in through the provider; returns the refresh token. */
const signInThrough = async (
  provider: Provider,
  user: { email: string },
  subject: string
) => {
  const flow = await upstreamLogin({
    provider: fake,
    slug: provider.slug,
    clientId: client.clientId,
    redirectUri: REDIRECT_URI,
    scope: SCOPE,
    claims: { sub: subject, email: user.email },
  });
  const res = await fetch(`${CORE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: await codeFrom(flow.jar, flow.location),
      redirect_uri: REDIRECT_URI,
      client_id: client.clientId,
      code_verifier: flow.verifier,
    }),
  });
  expect(res.status).toBe(200);
  const { refresh_token } = (await res.json()) as { refresh_token: string };
  expect(refresh_token).toBeTruthy();
  return refresh_token;
};

/** A user with a session through `provider` and one by password. */
const signedInBothWays = async (provider: Provider) => {
  const user = await createTestUser({ emailVerified: true });
  await signInThrough(provider, user, await link(user.id, provider));
  await getAccessTokenForUser(user, client);
  return user;
};

const live = (userId: string, federated: boolean) =>
  prisma.refreshToken.count({
    where: {
      userId,
      revokedAt: null,
      authCode: federated
        ? { authMethods: { has: "fed" } }
        : { NOT: { authMethods: { has: "fed" } } },
    },
  });
const ssoSessions = (userId: string, federated: boolean) =>
  prisma.userSession.count({
    where: {
      userId,
      ...(federated
        ? { authMethods: { has: "fed" } }
        : { NOT: { authMethods: { has: "fed" } } }),
    },
  });

const deactivate = async (provider: Provider) => {
  const response = await call("POST", `/${provider.id}/deactivate`);
  expect(response.status).toBe(200);
};

describe("processProviderDeactivationSessionSweep", () => {
  it("ends the federated sessions of the provider's users when it is deactivated, sparing password sessions and other providers' users", async () => {
    const provider = await newProvider();
    const other = await newProvider();
    const user = await createTestUser({ emailVerified: true });
    const refreshToken = await signInThrough(
      provider,
      user,
      await link(user.id, provider)
    );
    await getAccessTokenForUser(user, client);
    const outsider = await signedInBothWays(other);
    // Linked to both: the session does not say which provider it came from.
    const both = await createTestUser({ emailVerified: true });
    await link(both.id, provider);
    await signInThrough(other, both, await link(both.id, other));
    expect(await live(user.id, true)).toBe(1);
    expect(await ssoSessions(user.id, true)).toBe(1);

    await deactivate(provider);

    await waitFor(
      async () =>
        (await live(user.id, true)) === 0 && (await live(both.id, true)) === 0
    );
    expect(await ssoSessions(user.id, true)).toBe(0);
    expect(await live(user.id, false)).toBe(1);
    expect(await ssoSessions(user.id, false)).toBeGreaterThan(0);
    expect(await live(outsider.id, true)).toBe(1);
    expect(await ssoSessions(outsider.id, true)).toBe(1);

    const refreshed = await fetch(`${CORE_URL}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: client.clientId,
      }),
    });
    expect(refreshed.status).toBe(400);

    const entry = await prisma.auditLogEntry.findFirstOrThrow({
      where: { entityType: "User", entityId: user.id, action: "UPDATE" },
      orderBy: { createdAt: "desc" },
    });
    expect(entry.metadata).toMatchObject({ action: "sessions_revoked" });
    expect(
      (entry.metadata as { sessionIds: string[] }).sessionIds
    ).toHaveLength(1);
    await waitFor(
      async () =>
        (await prisma.webhookDelivery.count({
          where: {
            webhookEndpointId: eventsEndpointId,
            eventType: "auth.user.sessions-revoked",
            payload: { path: ["entityId"], equals: user.id },
          },
        })) === 1,
      10_000
    );
  });

  it("is queued under the deactivation's job id, and not when the provider was inactive already", async () => {
    const provider = await newProvider();
    await deactivate(provider);
    const { updatedAt } = await prisma.identityProvider.findUniqueOrThrow({
      where: { id: provider.id },
    });
    const queue = getProviderDeactivationSessionSweepQueue();
    await waitFor(async () => {
      const job = await queue.getJob(`${provider.id}__${updatedAt.getTime()}`);
      return job?.data.providerId === provider.id;
    });

    await deactivate(provider);
    const again = await prisma.identityProvider.findUniqueOrThrow({
      where: { id: provider.id },
    });
    expect(
      await queue.getJob(`${provider.id}__${again.updatedAt.getTime()}`)
    ).toBeUndefined();
  });

  it("ends the provider's login steps under way, and nothing once it is active again", async () => {
    const provider = await newProvider();
    const user = await signedInBothWays(provider);
    const stepUser = await createTestUser({ emailVerified: true });
    await link(stepUser.id, provider);
    const step = await prisma.orgSelectionSession.create({
      data: {
        tokenHash: generateUniqueId(),
        userId: stepUser.id,
        clientId: client.id,
        redirectUri: REDIRECT_URI,
        scopes: ["openid"],
        codeChallenge: "c".repeat(43),
        codeChallengeMethod: "S256",
        authTime: new Date(),
        authMethods: ["fed"],
        provider: provider.slug,
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    const data: ProviderDeactivationSessionSweepJobData = {
      actor: { userId: SYSTEM_USER_ID, email: null },
      providerId: provider.id,
    };
    const run = () =>
      processProviderDeactivationSessionSweep({
        data,
        updateData: async () => {},
      });

    await run();
    expect(await live(user.id, true)).toBe(1);
    expect(
      await prisma.orgSelectionSession.count({ where: { id: step.id } })
    ).toBe(1);

    // Deactivated with no run after it, as a crash after the commit leaves it.
    await prisma.identityProvider.update({
      where: { id: provider.id },
      data: { isActive: false },
    });
    await run();
    expect(await live(user.id, true)).toBe(0);
    expect(await live(user.id, false)).toBe(1);
    expect(
      await prisma.orgSelectionSession.count({ where: { id: step.id } })
    ).toBe(0);
  });

  it("retries only the users an attempt failed to sign out", async () => {
    const provider = await newProvider();
    const other = await newProvider();
    const done = await signedInBothWays(provider);
    const failing = await signedInBothWays(provider);
    await prisma.identityProvider.update({
      where: { id: provider.id },
      data: { isActive: false },
    });
    const job = {
      data: {
        actor: { userId: SYSTEM_USER_ID, email: null },
        providerId: provider.id,
      } as ProviderDeactivationSessionSweepJobData,
      updateData: async (data: ProviderDeactivationSessionSweepJobData) => {
        job.data = data;
      },
    };
    const lock = db.users.lockForSessionEnd;
    const spy = vi
      .spyOn(db.users, "lockForSessionEnd")
      .mockImplementation(async (tx, ids) => {
        if (ids.userIds?.includes(failing.id)) throw new Error("lost");
        return await lock(tx, ids);
      });
    try {
      await expect(
        processProviderDeactivationSessionSweep(job)
      ).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(job.data.userIds).toEqual([failing.id]);
    expect(await live(done.id, true)).toBe(0);
    expect(await live(failing.id, true)).toBe(1);

    // A session started since through another provider.
    await signInThrough(other, done, await link(done.id, other));
    await processProviderDeactivationSessionSweep(job);
    expect(await live(failing.id, true)).toBe(0);
    expect(await live(done.id, true)).toBe(1);
  });
});
