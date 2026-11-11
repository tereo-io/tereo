// @module-tag int
// @module-tag auth
import { clientSecretName } from "../../../utils/identityProviders/clientSecret.js";
import { createScimConnection, scimFetch } from "../../support/scim.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestClient } from "../../support/auth/clients.js";
import { sealRowSecret } from "../../../utils/sealedSecrets.js";
import { upstreamLogin } from "../../support/upstreamLogin.js";
import { oktaCreateUser } from "../../fixtures/scim/okta.js";
import { createTestUser } from "../../support/auth/users.js";
import { prisma } from "../../../utils/db/prisma.js";
import { tag } from "../../support/scimUsers.js";
import { randomUUID } from "node:crypto";
import env from "../../../env.js";
import {
  startFakeOidcProvider,
  type FakeClaims,
  type FakeOidcProvider,
} from "../../support/fakeOidcProvider.js";

const REDIRECT_URI = "http://localhost:3000/callback";
const SCOPE = "openid profile email";

let fake: FakeOidcProvider;
let client: Awaited<ReturnType<typeof createTestClient>>;

let lastIp = 0;
/** A client address of this file's own, so no limiter is shared. */
const freshIp = () => `10.78.0.${++lastIp}`;

/** A SCIM connection whose provider is the fake, reachable for sign-in. */
const connected = async () => {
  const c = await createScimConnection();
  const provider = await prisma.identityProvider.update({
    where: { id: c.providerId },
    data: {
      issuer: fake.issuer,
      clientId: fake.clientId,
      clientSecret: await sealRowSecret(
        clientSecretName(c.providerId),
        fake.clientSecret
      ),
    },
  });
  return { ...c, slug: provider.slug };
};

/** POST /scim/v2/Users: creates the user, or adopts the one with that email. */
const provision = async (token: string, email: string, externalId?: string) => {
  const { status } = await scimFetch(token, "POST", "/scim/v2/Users", {
    ...oktaCreateUser,
    userName: email,
    emails: [{ primary: true, type: "work", value: email }],
    externalId: externalId ?? `ext-${tag()}`,
  });
  expect(status).toBe(201);
  return await prisma.user.findUniqueOrThrow({ where: { email } });
};

const signIn = (slug: string, claims: Partial<FakeClaims> & { sub: string }) =>
  upstreamLogin({
    provider: fake,
    slug,
    clientId: client.clientId,
    redirectUri: REDIRECT_URI,
    scope: SCOPE,
    claims,
    ip: freshIp(),
  });

const expectSignedIn = (location: URL) =>
  expect(location.pathname).toBe("/consent");

const expectLoginError = (location: URL, error: string) => {
  expect(location.origin + location.pathname).toBe(`${env.UI_BASE_URL}/login`);
  expect(location.searchParams.get("error")).toBe(error);
};

const identitiesOf = (userId: string) =>
  prisma.userIdentity.findMany({ where: { userId } });

beforeAll(async () => {
  client = await createTestClient();
  fake = await startFakeOidcProvider();
});

afterAll(async () => {
  await fake.close();
});

describe("first sign-in of a SCIM-provisioned user", () => {
  it("signs in a SCIM-created user with a verified email and links the identity", async () => {
    const c = await connected();
    const user = await provision(c.token, `new-${tag()}@${c.domain}`);
    const sub = `sub-${randomUUID()}`;

    const { location } = await signIn(c.slug, {
      sub,
      email: user.email,
      email_verified: true,
    });
    expectSignedIn(location);

    const identities = await identitiesOf(user.id);
    expect(identities).toHaveLength(1);
    expect(identities[0]).toMatchObject({
      providerId: c.providerId,
      subject: sub,
    });
    const audit = await prisma.auditLogEntry.findFirstOrThrow({
      where: { entityType: "UserIdentity", entityId: identities[0].id },
    });
    expect(audit.metadata).toMatchObject({
      via: "scim",
      scimConnectionId: c.connectionId,
    });
  });

  it("does not claim on an unverified email without an object id", async () => {
    const c = await connected();
    const user = await provision(c.token, `unverified-${tag()}@${c.domain}`);

    const { location } = await signIn(c.slug, {
      sub: `sub-${randomUUID()}`,
      email: user.email,
      email_verified: false,
    });
    // As before SCIM: the domain does not auto-accept, and nothing is invited.
    expectLoginError(location, "no_account");
    expect(await identitiesOf(user.id)).toEqual([]);
  });

  it("ignores an oid claim from a provider that is not an Entra tenant", async () => {
    const c = await connected();
    const externalId = `oid-${tag()}`;
    const user = await provision(
      c.token,
      `oid-${tag()}@${c.domain}`,
      externalId
    );

    const { location } = await signIn(c.slug, {
      sub: `sub-${randomUUID()}`,
      email: user.email,
      email_verified: false,
      oid: externalId,
    });
    expectLoginError(location, "no_account");
    expect(await identitiesOf(user.id)).toEqual([]);
  });

  it("links an adopted user with a password", async () => {
    const c = await connected();
    const existing = await createTestUser({
      email: `adopted-${tag()}@${c.domain}`,
    });
    const user = await provision(c.token, existing.email);
    expect(user.id).toBe(existing.id);
    expect(user.passwordHash).not.toBeNull();
    const sub = `sub-${randomUUID()}`;

    const { location } = await signIn(c.slug, {
      sub,
      email: existing.email,
      email_verified: true,
    });
    expectSignedIn(location);
    expect(await identitiesOf(existing.id)).toMatchObject([
      { providerId: c.providerId, subject: sub },
    ]);
  });

  it("refuses a deactivated managed user, and does not reactivate them", async () => {
    const c = await connected();
    const user = await provision(c.token, `inactive-${tag()}@${c.domain}`);
    await prisma.user.update({
      where: { id: user.id },
      data: { isActive: false },
    });

    const { location } = await signIn(c.slug, {
      sub: `sub-${randomUUID()}`,
      email: user.email,
      email_verified: true,
    });
    expectLoginError(location, "account_inactive");
    const after = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(after.isActive).toBe(false);
  });

  it("does not claim a user whose SCIM resource was deleted", async () => {
    const c = await connected();
    const user = await provision(c.token, `deleted-${tag()}@${c.domain}`);
    await prisma.scimUser.update({
      where: { userId: user.id },
      data: { deletedAt: new Date() },
    });

    const { location } = await signIn(c.slug, {
      sub: `sub-${randomUUID()}`,
      email: user.email,
      email_verified: true,
    });
    expectLoginError(location, "no_account");
    expect(await identitiesOf(user.id)).toEqual([]);
  });

  it("does not claim through an inactive connection", async () => {
    const c = await connected();
    const user = await provision(c.token, `paused-${tag()}@${c.domain}`);
    await prisma.scimConnection.update({
      where: { id: c.connectionId },
      data: { isActive: false },
    });

    const { location } = await signIn(c.slug, {
      sub: `sub-${randomUUID()}`,
      email: user.email,
      email_verified: true,
    });
    expectLoginError(location, "no_account");
    expect(await identitiesOf(user.id)).toEqual([]);
  });

  it("answers sso_required when the user's domain is SSO-only for another provider", async () => {
    const c = await connected();
    const other = await createScimConnection({ domains: [] });
    const user = await provision(c.token, `elsewhere-${tag()}@${c.domain}`);
    await prisma.identityProviderDomain.update({
      where: { domain: c.domain },
      data: { providerId: other.providerId, ssoOnly: true },
    });
    const otherSlug = (
      await prisma.identityProvider.findUniqueOrThrow({
        where: { id: other.providerId },
      })
    ).slug;

    const { location } = await signIn(c.slug, {
      sub: `sub-${randomUUID()}`,
      email: user.email,
      email_verified: true,
    });
    expectLoginError(location, "sso_required");
    expect(location.searchParams.get("provider")).toBe(otherSlug);
    expect(await identitiesOf(user.id)).toEqual([]);
  });

  it("signs in again through the linked identity without a second link", async () => {
    const c = await connected();
    const user = await provision(c.token, `again-${tag()}@${c.domain}`);
    const claims = {
      sub: `sub-${randomUUID()}`,
      email: user.email,
      email_verified: true,
    };

    expectSignedIn((await signIn(c.slug, claims)).location);
    expectSignedIn((await signIn(c.slug, claims)).location);

    const identities = await identitiesOf(user.id);
    expect(identities).toHaveLength(1);
    expect(identities[0].lastLoginAt).not.toBeNull();
    expect(
      await prisma.auditLogEntry.count({
        where: { entityType: "UserIdentity", entityId: identities[0].id },
      })
    ).toBe(1);
  });
});
