// @module-tag int
// @module-tag auth
// @module-tag job

import { ensureDefaultOrganization } from "../../utils/defaultOrganization.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SYSTEM_USER_ID } from "../../definitions/index.js";
import { prisma } from "../../utils/db/prisma.js";
import { CORE_URL } from "../support/coreUrl.js";
import { waitFor } from "../support/webhooks.js";
import db from "../../utils/db/index.js";
import { randomUUID } from "node:crypto";
import {
  closeSsoOnlySessionSweepQueue,
  getSsoOnlySessionSweepQueue,
  processSsoOnlySessionSweep,
  type SsoOnlySessionSweepJobData,
} from "../../jobs/ssoOnlySessionSweep.js";
import {
  startFakeOidcProvider,
  FakeOidcProvider,
} from "../support/fakeOidcProvider.js";
import {
  ensureTestOrganization,
  getTestPrincipalToken,
} from "../support/principals.js";
import {
  createTestClient,
  createTestUser,
  generateUniqueId,
  getAccessTokenForUser,
} from "../support/auth.js";

declare global {
  interface Response {
    // Test bodies are checked field by field.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    json(): Promise<any>;
  }
}

const BASE = `${CORE_URL}/v1/admin/identity-providers`;

let fake: FakeOidcProvider;
let writeToken: string;
let adminToken: string;
let orgId: string;

beforeAll(async () => {
  fake = await startFakeOidcProvider();
  writeToken = await getTestPrincipalToken({
    permissions: ["identity-providers.write"],
  });
  // SSO-only changes and moving such a provider need a global admin.
  adminToken = await getTestPrincipalToken({ permissions: ["admin"] });
  orgId = await ensureTestOrganization(`idp-org-${generateUniqueId()}`);
});

afterAll(async () => {
  await fake.close();
});

const call = (token: string, method: string, path: string, body?: unknown) =>
  fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const createProvider = async (overrides: Record<string, unknown> = {}) => {
  const response = await call(writeToken, "POST", "", {
    slug: `p-${generateUniqueId().toLowerCase()}`.slice(0, 40),
    displayName: "Fake IdP",
    kind: "oidc",
    issuer: fake.issuer,
    clientId: fake.clientId,
    clientSecret: fake.clientSecret,
    ...overrides,
  });
  return response;
};

const newProvider = async () => {
  const response = await createProvider();
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; slug: string };
};

describe("processSsoOnlySessionSweep", () => {
  const postDomain = (token: string, providerId: string, body: object) =>
    call(token, "POST", `/${providerId}/domains`, {
      organizationId: orgId,
      autoAccept: false,
      ssoOnly: false,
      roleIds: [],
      ...body,
    });

  let client: Awaited<ReturnType<typeof createTestClient>>;

  beforeAll(async () => {
    client = await createTestClient();
    // Called here, outside the server: what it emits needs the cache.
    await ensureDefaultOrganization();
  });

  afterAll(async () => {
    await closeSsoOnlySessionSweepQueue();
  });

  /** A signed-in user at `domain`, with an identity at `providerId` if given. */
  const signedIn = async (domain: string, providerId?: string) => {
    const user = await createTestUser({
      email: `u-${generateUniqueId().toLowerCase()}@${domain}`,
    });
    if (providerId) {
      await prisma.userIdentity.create({
        data: { userId: user.id, providerId, subject: randomUUID() },
      });
    }
    await getAccessTokenForUser(user, client);
    return user;
  };
  const liveSessions = (userId: string) =>
    prisma.refreshToken.count({ where: { userId, revokedAt: null } });

  it("ends them when a domain is created SSO-only, sparing its own provider's and password users", async () => {
    const provider = await newProvider();
    const other = await newProvider();
    const name = `ssoend-${generateUniqueId().toLowerCase()}.com`;
    const elsewhere = await signedIn(name, other.id);
    const own = await signedIn(name, provider.id);
    const passwordOnly = await signedIn(name);
    const outside = await signedIn(
      `ssoout-${generateUniqueId().toLowerCase()}.com`,
      other.id
    );

    const created = await postDomain(adminToken, provider.id, {
      domain: name,
      ssoOnly: true,
    });
    expect(created.status).toBe(201);

    await waitFor(async () => (await liveSessions(elsewhere.id)) === 0);
    for (const kept of [own, passwordOnly, outside]) {
      expect(await liveSessions(kept.id)).toBeGreaterThan(0);
    }
    const entry = await prisma.auditLogEntry.findFirstOrThrow({
      where: { entityType: "User", entityId: elsewhere.id },
      orderBy: { createdAt: "desc" },
    });
    expect(entry.metadata).toMatchObject({ action: "sessions_revoked" });
  });

  it("ends them when a domain is PATCHed SSO-only, and not on other changes", async () => {
    const provider = await newProvider();
    const other = await newProvider();
    const name = `ssopatch-${generateUniqueId().toLowerCase()}.com`;
    const created = await postDomain(writeToken, provider.id, {
      domain: name,
    });
    const path = `/${provider.id}/domains/${(await created.json()).id}`;
    const elsewhere = await signedIn(name, other.id);

    expect(
      (await call(writeToken, "PATCH", path, { autoAccept: true })).status
    ).toBe(200);
    expect(await liveSessions(elsewhere.id)).toBeGreaterThan(0);

    const patched = await call(adminToken, "PATCH", path, {
      ssoOnly: true,
    });
    expect(patched.status).toBe(200);
    // Swept by the worker, after the response, under the change's job id.
    const { id: domainId, updatedAt } =
      await prisma.identityProviderDomain.findFirstOrThrow({
        where: { domain: name },
      });
    const job = await getSsoOnlySessionSweepQueue().getJob(
      `${domainId}__${updatedAt.getTime()}`
    );
    expect(job?.data).toMatchObject({
      providerId: provider.id,
      domainId,
      actor: { email: expect.any(String) },
    });
    await waitFor(async () => (await liveSessions(elsewhere.id)) === 0);
  });

  it("ends what is left when run again, and nothing once SSO-only is lifted", async () => {
    const provider = await newProvider();
    const other = await newProvider();
    const name = `ssorerun-${generateUniqueId().toLowerCase()}.com`;
    const created = await (
      await postDomain(writeToken, provider.id, { domain: name })
    ).json();
    const elsewhere = await signedIn(name, other.id);
    const setSsoOnly = (ssoOnly: boolean) =>
      prisma.identityProviderDomain.update({
        where: { id: created.id },
        data: { ssoOnly },
      });
    const data: SsoOnlySessionSweepJobData = {
      actor: { userId: SYSTEM_USER_ID, email: null },
      providerId: provider.id,
      domainId: created.id,
    };
    const run = () =>
      processSsoOnlySessionSweep({ data, updateData: async () => {} });
    const audits = () =>
      prisma.auditLogEntry.count({
        where: { entityType: "User", entityId: elsewhere.id },
      });

    // Closed with no run after it, as a crash after the commit leaves it.
    await setSsoOnly(true);
    await run();
    expect(await liveSessions(elsewhere.id)).toBe(0);
    const audited = await audits();
    expect(audited).toBeGreaterThan(0);

    await run();
    expect(await audits()).toBe(audited);

    await setSsoOnly(false);
    const reopened = await signedIn(name, other.id);
    await run();
    expect(await liveSessions(reopened.id)).toBeGreaterThan(0);
  });

  it("retries only the users an attempt failed to sign out", async () => {
    const provider = await newProvider();
    const other = await newProvider();
    const name = `ssoretry-${generateUniqueId().toLowerCase()}.com`;
    const created = await (
      await postDomain(writeToken, provider.id, { domain: name })
    ).json();
    const done = await signedIn(name, other.id);
    const failing = await signedIn(name, other.id);
    const setSsoOnly = (ssoOnly: boolean) =>
      prisma.identityProviderDomain.update({
        where: { id: created.id },
        data: { ssoOnly },
      });
    await setSsoOnly(true);
    const job = {
      data: {
        actor: { userId: SYSTEM_USER_ID, email: null },
        providerId: provider.id,
        domainId: created.id,
      } as SsoOnlySessionSweepJobData,
      updateData: async (data: SsoOnlySessionSweepJobData) => {
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
      await expect(processSsoOnlySessionSweep(job)).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(job.data.userIds).toEqual([failing.id]);
    expect(await liveSessions(done.id)).toBe(0);
    expect(await liveSessions(failing.id)).toBeGreaterThan(0);

    // A session started since, standing in for one through the domain's
    // own provider.
    await setSsoOnly(false);
    await getAccessTokenForUser(done, client);
    await setSsoOnly(true);
    await processSsoOnlySessionSweep(job);
    expect(await liveSessions(failing.id)).toBe(0);
    expect(await liveSessions(done.id)).toBeGreaterThan(0);
  });
});
