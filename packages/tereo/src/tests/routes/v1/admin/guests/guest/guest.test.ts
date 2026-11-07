// @module-tag int
// @module-tag auth
import { DEFAULT_ORGANIZATION_ID } from "../../../../../../definitions/index.js";
import { createTestClient } from "../../../../../support/auth/clients.js";
import { createTestGuest } from "../../../../../support/auth/guests.js";
import { BASE_URL } from "../../../../../support/auth/constants.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { fetchJson } from "../../../../../support/http.js";
import { describe, it, expect, beforeAll } from "vitest";
import env from "../../../../../../env.js";
import { randomUUID } from "node:crypto";
import {
  ensureTestOrganization,
  getTestPrincipalToken,
} from "../../../../../support/principals.js";
import {
  createAdminUser,
  createTestUser,
} from "../../../../../support/auth/users.js";
import {
  getAccessTokenForUser,
  json,
  loginAndExchange,
  postForm,
} from "../../../../../support/auth/login.js";
import {
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../../../../../support/webhooks.js";

const REDIRECT_URI = "http://localhost:3000/admin-guest-callback";
const SCOPE = "openid profile email offline_access core:account";
const DAY_MS = 86_400_000;

let adminToken: string;
let client: Awaited<ReturnType<typeof createTestClient>>;
let orgId: string;
let otherOrgId: string;

beforeAll(async () => {
  adminToken = await getAccessTokenForUser(
    await createAdminUser(),
    await createTestClient()
  );
  client = await createTestClient({ redirectUris: [REDIRECT_URI] });
  orgId = await ensureTestOrganization("admin-guest");
  otherOrgId = await ensureTestOrganization("admin-guest-other");
});

const patch = (id: string, body: unknown) =>
  fetchJson("PATCH", `${BASE_URL}/v1/admin/guests/${id}`, adminToken, body);

const signIn = (g: Awaited<ReturnType<typeof createTestGuest>>) =>
  loginAndExchange(
    client,
    { email: g.user.email, plainPassword: g.plainPassword },
    REDIRECT_URI,
    SCOPE
  );

const me = async (accessToken: string) =>
  (
    await fetch(`${BASE_URL}/v1/account/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
  ).status;

const refresh = (refreshToken: string) =>
  postForm("/oauth/token", {
    grant_type: "refresh_token",
    client_id: client.clientId,
    refresh_token: refreshToken,
  });

const lastGuestAction = async (userId: string) =>
  (
    (
      await prisma.auditLogEntry.findFirstOrThrow({
        where: { entityId: userId, entityType: "User", action: "UPDATE" },
        orderBy: { createdAt: "desc" },
        select: { metadata: true },
      })
    ).metadata as { action: string }
  ).action;

const liveRefreshExpiries = async (userId: string) =>
  (
    await prisma.refreshToken.findMany({
      where: { userId, revokedAt: null },
      select: { expiresAt: true },
    })
  ).map((t) => t.expiresAt.getTime());

describe("GET /v1/admin/guests/:id", () => {
  it("returns the guest with its organization and status", async () => {
    const { user } = await createTestGuest({ organizationId: orgId });
    const res = await fetchJson(
      "GET",
      `${BASE_URL}/v1/admin/guests/${user.id}`,
      adminToken
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: user.id,
      userType: "guest",
      status: "active",
      organizationId: orgId,
      expiresAt: user.expiresAt!.toISOString(),
    });
  });

  it("returns 404 not_a_guest for a regular user", async () => {
    const human = await createTestUser();
    const res = await fetchJson(
      "GET",
      `${BASE_URL}/v1/admin/guests/${human.id}`,
      adminToken
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_a_guest");
  });
});

describe("PATCH /v1/admin/guests/:id", () => {
  it("extends the guest and emits auth.guest.extended", async () => {
    const { user } = await createTestGuest({ organizationId: orgId });
    const endpoint = await createTestWebhookEndpoint(
      await getCoreEventSubscriberToken(orgId),
      { eventTypes: ["auth.guest.extended"] }
    );
    const platform = await createTestWebhookEndpoint(
      await getCoreEventSubscriberToken(DEFAULT_ORGANIZATION_ID),
      { eventTypes: ["auth.guest.extended"] }
    );
    const later = new Date(Date.now() + 30 * DAY_MS);

    const res = await patch(user.id, {
      expiresAt: later.toISOString(),
      name: "Renamed",
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      expiresAt: later.toISOString(),
      name: "Renamed",
      status: "active",
    });
    const where = {
      webhookEndpointId: endpoint.id,
      eventType: "auth.guest.extended",
      payload: { path: ["entityId"], equals: user.id },
    };
    await waitFor(
      async () => (await prisma.webhookDelivery.count({ where })) > 0,
      10_000
    );
    const delivery = await prisma.webhookDelivery.findFirstOrThrow({ where });
    expect(
      (delivery.payload as { data: Record<string, unknown> }).data
    ).toMatchObject({
      id: user.id,
      organizationId: orgId,
      previousExpiresAt: user.expiresAt!.toISOString(),
      expiresAt: later.toISOString(),
      rolesAdded: [],
      change: "extended",
    });
    // Deliveries of one event are written together.
    expect(
      await prisma.webhookDelivery.count({
        where: { ...where, webhookEndpointId: platform.id },
      })
    ).toBe(0);
  });

  it("refuses a null expiresAt, leaving the guest as they were", async () => {
    const { user } = await createTestGuest({ organizationId: orgId });
    const res = await patch(user.id, { expiresAt: null });
    expect(res.status).toBe(400);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: user.id } }))
        .expiresAt
    ).toEqual(user.expiresAt);
  });

  it("audits a shortening as guest_shortened", async () => {
    const { user } = await createTestGuest({
      organizationId: orgId,
      expiresAt: new Date(Date.now() + 10 * DAY_MS),
    });
    const res = await patch(user.id, {
      expiresAt: new Date(Date.now() + DAY_MS).toISOString(),
    });
    expect(res.status).toBe(200);
    expect(await lastGuestAction(user.id)).toBe("guest_shortened");
  });

  it("returns 404 not_a_guest for a guest promoted since", async () => {
    const { user } = await createTestGuest({ organizationId: orgId });
    const promoted = await fetchJson(
      "POST",
      `${BASE_URL}/v1/admin/users/${user.id}/promote`,
      adminToken
    );
    expect(promoted.status).toBe(200);

    const res = await patch(user.id, {
      expiresAt: new Date(Date.now() + DAY_MS).toISOString(),
    });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_a_guest");
  });

  it("returns 404 not_a_guest for a regular user", async () => {
    const human = await createTestUser();
    const res = await patch(human.id, {
      expiresAt: new Date(Date.now() + DAY_MS).toISOString(),
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_a_guest");
    const after = await prisma.user.findUniqueOrThrow({
      where: { id: human.id },
    });
    expect(after.expiresAt).toBeNull();
  });

  it("expiresAt in the past ends access now", async () => {
    const g = await createTestGuest({ organizationId: orgId });
    const tokens = await signIn(g);
    expect(await me(tokens.access_token)).toBe(200);

    const res = await patch(g.user.id, {
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("expired");
    expect(await lastGuestAction(g.user.id)).toBe("guest_access_ended");
    // Revoked, not only refused for the expiry: their sockets close too.
    expect(
      await prisma.accessToken.count({
        where: { userId: g.user.id, revokedAt: null },
      })
    ).toBe(0);
    expect(await me(tokens.access_token)).toBe(401);
    const refreshed = await refresh(tokens.refresh_token);
    expect(refreshed.status).toBe(400);
    expect((await json(refreshed)).error).toBe("invalid_grant");
  });

  it("shortening lowers the guest's refresh tokens to the new expiry", async () => {
    const g = await createTestGuest({
      organizationId: orgId,
      expiresAt: new Date(Date.now() + 10 * DAY_MS),
    });
    await signIn(g);
    const sooner = new Date(Date.now() + DAY_MS);

    expect((await patch(g.user.id, { expiresAt: sooner })).status).toBe(200);

    expect(await liveRefreshExpiries(g.user.id)).toEqual([sooner.getTime()]);
  });

  it("extending keeps an existing refresh token usable past the old expiry", async () => {
    // JWT_REFRESH_TOKEN_TTL is longer than a day, so sign-in caps the
    // refresh token at the account's expiry.
    const oldExpiry = new Date(Date.now() + DAY_MS);
    const g = await createTestGuest({
      organizationId: orgId,
      expiresAt: oldExpiry,
    });
    const tokens = await signIn(g);
    expect(await liveRefreshExpiries(g.user.id)).toEqual([oldExpiry.getTime()]);

    const later = new Date(Date.now() + 10 * DAY_MS);
    expect((await patch(g.user.id, { expiresAt: later })).status).toBe(200);

    expect(await liveRefreshExpiries(g.user.id)).toEqual([later.getTime()]);
    // The rotated token keeps the raised expiry, not the old cap.
    const refreshed = await refresh(tokens.refresh_token);
    expect(refreshed.status).toBe(200);
    expect(await liveRefreshExpiries(g.user.id)).toEqual([later.getTime()]);
  });

  it("raises a capped token no further than its family's lifetime", async () => {
    const g = await createTestGuest({
      organizationId: orgId,
      expiresAt: new Date(Date.now() + DAY_MS),
    });
    await signIn(g);
    const [token] = await prisma.refreshToken.findMany({
      where: { userId: g.user.id, revokedAt: null },
    });

    await patch(g.user.id, {
      expiresAt: new Date(
        Date.now() + (env.JWT_REFRESH_TOKEN_TTL + 3600) * 1000
      ).toISOString(),
    });

    expect(await liveRefreshExpiries(g.user.id)).toEqual([
      token.createdAt.getTime() + env.JWT_REFRESH_TOKEN_TTL * 1000,
    ]);
  });
});

describe("guest actions outside the caller's organizations", () => {
  const scopedCaller = async (permissions: string[]) => {
    const userId = randomUUID();
    const token = await getTestPrincipalToken({
      userId,
      organizationId: orgId,
      permissions,
    });
    await prisma.organizationMember.create({
      data: { organizationId: orgId, userId, memberRole: "member" },
    });
    return token;
  };

  // Scope comes first: an outsider cannot tell a guest elsewhere from a
  // user who is not a guest or does not exist.
  it.each([
    [
      "a guest in another organization",
      async () =>
        (await createTestGuest({ organizationId: otherOrgId })).user.id,
    ],
    [
      "a guest in no organization",
      async () => {
        const { user } = await createTestGuest({ organizationId: otherOrgId });
        await prisma.organizationMember.deleteMany({
          where: { userId: user.id },
        });
        return user.id;
      },
    ],
    ["a regular user", async () => (await createTestUser()).id],
    ["an unknown id", async () => randomUUID()],
  ])("GET and PATCH answer 404 not_a_guest for %s", async (_label, make) => {
    const id = await make();
    const token = await scopedCaller(["users.guests.write"]);

    const got = await fetchJson(
      "GET",
      `${BASE_URL}/v1/admin/guests/${id}`,
      token
    );
    const patched = await fetchJson(
      "PATCH",
      `${BASE_URL}/v1/admin/guests/${id}`,
      token,
      { expiresAt: new Date(Date.now() + 30 * DAY_MS).toISOString() }
    );

    for (const res of [got, patched]) {
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("not_a_guest");
    }
  });

  it("PATCH leaves a guest outside the caller's organizations unchanged", async () => {
    const { user } = await createTestGuest({ organizationId: otherOrgId });
    const token = await scopedCaller(["users.guests.write"]);
    await fetchJson("PATCH", `${BASE_URL}/v1/admin/guests/${user.id}`, token, {
      expiresAt: new Date(Date.now() + 30 * DAY_MS).toISOString(),
    });
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: user.id } }))
        .expiresAt
    ).toEqual(user.expiresAt);
  });

  it("GET returns a guest in the caller's organization", async () => {
    const { user } = await createTestGuest({ organizationId: orgId });
    const token = await scopedCaller(["users.guests.read"]);
    const res = await fetchJson(
      "GET",
      `${BASE_URL}/v1/admin/guests/${user.id}`,
      token
    );
    expect(res.status).toBe(200);
    expect(res.body.organizationId).toBe(orgId);
  });

  it("treats a guest whose organization is archived as in none", async () => {
    const archived = await ensureTestOrganization(
      `admin-guest-archived-${randomUUID()}`
    );
    const { user } = await createTestGuest({ organizationId: archived });
    const userId = randomUUID();
    const token = await getTestPrincipalToken({
      userId,
      permissions: ["users.guests.read"],
    });
    await prisma.organizationMember.create({
      data: { organizationId: archived, userId, memberRole: "member" },
    });
    await prisma.organization.update({
      where: { id: archived },
      data: { isActive: false, archivedAt: new Date() },
    });

    const scoped = await fetchJson(
      "GET",
      `${BASE_URL}/v1/admin/guests/${user.id}`,
      token
    );
    expect(scoped.status).toBe(404);
    const admin = await fetchJson(
      "GET",
      `${BASE_URL}/v1/admin/guests/${user.id}`,
      adminToken
    );
    expect(admin.status).toBe(200);
    expect(admin.body.organizationId).toBeNull();
  });
});
