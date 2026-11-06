// @module-tag int
// @module-tag auth
// @module-tag security
import { loginAndExchange, postForm, json } from "../../support/auth/login.js";
import { createTestClient } from "../../support/auth/clients.js";
import { createTestGuest } from "../../support/auth/guests.js";
import { createTestUser } from "../../support/auth/users.js";
import { makeServiceOf } from "../../support/testService.js";
import { BASE_URL } from "../../support/auth/constants.js";
import { describe, it, expect, beforeAll } from "vitest";
import { decodeJwt } from "../../support/auth/tokens.js";
import { prisma } from "../../../utils/db/prisma.js";
import { randomUUID } from "crypto";
import env from "../../../env.js";
import {
  absorbCookies,
  cookieHeader,
  newPkce,
} from "../../support/browserLogin.js";
import {
  ensureTestOrganization,
  getTestPrincipalToken,
} from "../../support/principals.js";
import {
  createTestBucket,
  createTestFile,
  getTestAccessToken,
  grantTestPermission,
  uploadTestObjectAndGetId,
} from "../../support/files.js";

const REDIRECT_URI = "http://localhost:3000/guest-expiry-callback";
const SCOPE = "openid profile email offline_access core:account";

let client: Awaited<ReturnType<typeof createTestClient>>;
let introspector: Awaited<ReturnType<typeof createTestClient>>;
let organizationId: string;

beforeAll(async () => {
  introspector = await createTestClient({ clientType: "confidential" });
  client = await createTestClient({
    redirectUris: [REDIRECT_URI],
    audience: [await makeServiceOf(introspector.id)],
  });
  organizationId = await ensureTestOrganization("guest-expiry");
});

const guest = (expiresAt?: Date) =>
  createTestGuest({ organizationId, expiresAt });

const signIn = async (user: { email: string; plainPassword: string }) =>
  (await loginAndExchange(client, user, REDIRECT_URI, SCOPE)) as Awaited<
    ReturnType<typeof loginAndExchange>
  > & { expires_in: number };

const signInGuest = (g: Awaited<ReturnType<typeof guest>>) =>
  signIn({ email: g.user.email, plainPassword: g.plainPassword });

const expire = (userId: string) =>
  prisma.$executeRaw`UPDATE "auth"."users" SET expires_at = now() - interval '1 second' WHERE id = ${userId}::uuid`;

const me = async (accessToken: string) => {
  const res = await fetch(`${BASE_URL}/v1/account/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return { status: res.status, body: await json(res) };
};

const refresh = (refreshToken: string) =>
  postForm("/oauth/token", {
    grant_type: "refresh_token",
    client_id: client.clientId,
    refresh_token: refreshToken,
  });

const introspect = async (token: string) => {
  const res = await postForm(
    "/oauth/introspect",
    { token },
    {
      Authorization: `Basic ${Buffer.from(
        `${introspector.clientId}:${introspector.plainSecret}`
      ).toString("base64")}`,
    }
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { active: boolean }).active;
};

/** The password step of the authorize flow, as the login page sends it. */
const submitPassword = async (email: string, password: string) => {
  const pkce = newPkce();
  const params = {
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: REDIRECT_URI,
    state: pkce.state,
    scope: SCOPE,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
  };
  const jar = new Map<string, string>();
  const start = await fetch(
    `${BASE_URL}/oauth/authorize?${new URLSearchParams(params)}`,
    { redirect: "manual" }
  );
  absorbCookies(jar, start);
  const res = await fetch(`${BASE_URL}/oauth/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieHeader(jar) },
    body: JSON.stringify({ ...params, email, password }),
  });
  return { status: res.status, body: await json(res) };
};

describe("guest expiry", () => {
  it("guest signs in with password", async () => {
    const tokens = await signInGuest(await guest());
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();
  });

  it("access stops at expiry", async () => {
    const g = await guest();
    const tokens = await signInGuest(g);
    expect((await me(tokens.access_token)).status).toBe(200);
    expect(await introspect(tokens.access_token)).toBe(true);

    await expire(g.user.id);

    const after = await me(tokens.access_token);
    expect(after.status).toBe(401);
    expect(JSON.stringify(after.body)).toContain("User account is inactive");

    const refreshed = await refresh(tokens.refresh_token);
    expect(refreshed.status).toBe(400);
    expect((await json(refreshed)).error).toBe("invalid_grant");

    expect(await introspect(tokens.access_token)).toBe(false);
  });

  it("refuses an expired guest exactly as a deactivated user", async () => {
    const g = await guest();
    const tokens = await signInGuest(g);
    const deactivated = await createTestUser();
    const other = await signIn(deactivated);

    await expire(g.user.id);
    await prisma.user.update({
      where: { id: deactivated.id },
      data: { isActive: false },
    });

    expect(await me(tokens.access_token)).toEqual(await me(other.access_token));
    const [a, b] = await Promise.all([
      refresh(tokens.refresh_token),
      refresh(other.refresh_token),
    ]);
    expect([a.status, await json(a)]).toEqual([b.status, await json(b)]);
  });

  it("expired guest login looks like a wrong password", async () => {
    const expired = await guest(new Date(Date.now() - 1000));
    const other = await guest();

    const refused = await submitPassword(
      expired.user.email,
      expired.plainPassword
    );
    const wrong = await submitPassword(other.user.email, "WrongPassword123!");

    expect(refused.status).toBe(wrong.status);
    expect(refused.body).toEqual(wrong.body);
  });

  it("access token and refresh lifetime are capped at expiry", async () => {
    expect(env.JWT_ACCESS_TOKEN_TTL).toBeGreaterThan(120);
    const g = await guest(new Date(Date.now() + 120_000));
    const tokens = await signInGuest(g);

    expect(tokens.expires_in).toBeLessThanOrEqual(120);
    expect(tokens.expires_in).toBeGreaterThan(0);
    const claims = decodeJwt(tokens.access_token);
    expect(claims.exp).toBeLessThanOrEqual(
      Math.floor(g.user.expiresAt!.getTime() / 1000)
    );

    const row = await prisma.refreshToken.findFirstOrThrow({
      where: { userId: g.user.id },
    });
    expect(row.expiresAt.getTime()).toBeLessThanOrEqual(
      g.user.expiresAt!.getTime()
    );

    const rotated = await refresh(tokens.refresh_token);
    expect(rotated.status).toBe(200);
    expect(
      ((await rotated.json()) as { expires_in: number }).expires_in
    ).toBeLessThanOrEqual(120);
  });

  it("presigned URL by an expired guest stops working", async () => {
    const admin = await getTestAccessToken();
    const bucket = await createTestBucket(admin, { policy: "private" });
    const objectId = await uploadTestObjectAndGetId(
      admin,
      bucket.name,
      `guest/${randomUUID()}.txt`,
      createTestFile("guest-bytes")
    );
    // A guest holds permissions only through a guest-assignable role
    // assigned in an organization.
    const role = await prisma.role.create({
      data: {
        name: `guest-expiry-${randomUUID()}`,
        displayName: "Guest expiry reader",
        guestAssignable: true,
        rolePermissions: {
          create: {
            permission: { connect: { name: "file-service.objects.read" } },
          },
        },
      },
    });
    const { user } = await createTestGuest({
      organizationId,
      expiresAt: new Date(Date.now() + 60_000),
      roleIds: [role.id],
    });
    const userId = user.id;
    const token = await getTestPrincipalToken({
      userId,
      organizationId,
      permissions: [],
    });
    await grantTestPermission(admin, bucket.name, userId, { canRead: true });

    const presigned = await fetch(
      `${BASE_URL}/v1/files/buckets/${bucket.name}/objects/by-id/${objectId}/presign`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ operation: "read", expiresInSeconds: 300 }),
      }
    );
    expect(presigned.status).toBe(200);
    const { url } = (await presigned.json()) as { url: string };
    expect((await fetch(url)).status).toBe(200);

    await expire(userId);

    expect((await fetch(url)).status).toBe(403);
  });
});
