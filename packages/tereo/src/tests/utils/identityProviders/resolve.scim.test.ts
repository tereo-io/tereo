// @module-tag int
// @module-tag auth
import type { NormalizedIdentity } from "../../../utils/identityProviders/types.js";
import { resolveLoginIdentity } from "../../../utils/identityProviders/resolve.js";
import { ensureDefaultOrganization } from "../../../utils/defaultOrganization.js";
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { ensureTestOrganization } from "../../support/principals.js";
import { createTestUser } from "../../support/auth/users.js";
import { prisma } from "../../../utils/db/prisma.js";
import { manage } from "../../support/scimUsers.js";
import { logger } from "../../../utils/logger.js";
import db from "../../../utils/db/index.js";
import { randomBytes } from "node:crypto";

const ENTRA =
  "https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/v2.0";
const GOOGLE = "https://accounts.google.com";
const unique = () => randomBytes(8).toString("hex");

let adminId: string;

/** A provider with an active SCIM connection and one domain. */
const scimProvider = async (issuer = ENTRA) => {
  const provider = await db.identityProviders.create({
    slug: `scim-resolve-${unique()}`,
    displayName: "SCIM resolve",
    kind: "oidc",
    issuer,
    clientId: "cid",
    clientSecret: "sealed",
    createdBy: adminId,
  });
  const domain = `${unique()}.example.test`;
  await db.identityProviders.createDomain({
    providerId: provider.id,
    domain,
    organizationId: await ensureTestOrganization(`scim-resolve-${unique()}`),
    autoAccept: false,
    createdBy: adminId,
  });
  const connection = await prisma.scimConnection.create({
    data: { providerId: provider.id, createdBy: adminId },
  });
  return { provider, connection, domain };
};

const identity = (
  overrides: Partial<NormalizedIdentity> = {}
): NormalizedIdentity => ({
  subject: `sub-${unique()}`,
  email: null,
  emailVerified: false,
  name: null,
  firstName: null,
  lastName: null,
  hostedDomain: null,
  objectId: null,
  authTime: null,
  ...overrides,
});

const managedUser = async (
  connectionId: string,
  domain: string,
  externalId?: string
) => {
  const user = await createTestUser({ email: `m-${unique()}@${domain}` });
  await manage(connectionId, user.id, user.email, { externalId });
  return user;
};

const identitiesOf = (userId: string) =>
  prisma.userIdentity.findMany({ where: { userId } });

beforeAll(async () => {
  await ensureDefaultOrganization();
  adminId = (await createTestUser()).id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveLoginIdentity claiming a SCIM user", () => {
  it("claims by Entra object id without a verified email", async () => {
    const { provider, connection, domain } = await scimProvider();
    const oid = randomBytes(16).toString("hex");
    const user = await managedUser(connection.id, domain, oid);
    const id = identity({ objectId: oid, email: user.email });

    expect(await resolveLoginIdentity(provider, id)).toEqual({
      userId: user.id,
    });
    const [linked] = await identitiesOf(user.id);
    expect(linked).toMatchObject({
      providerId: provider.id,
      subject: id.subject,
    });
    const audit = await prisma.auditLogEntry.findFirstOrThrow({
      where: { entityType: "UserIdentity", entityId: linked.id },
    });
    expect(audit.metadata).toMatchObject({
      via: "scim",
      scimConnectionId: connection.id,
    });
  });

  it("falls back to the trusted email when no object id matches", async () => {
    const { provider, connection, domain } = await scimProvider();
    const user = await managedUser(connection.id, domain, "other-oid");
    const id = identity({
      objectId: "unknown-oid",
      email: user.email.toUpperCase(),
      emailVerified: true,
    });
    expect(await resolveLoginIdentity(provider, id)).toEqual({
      userId: user.id,
    });
  });

  it("claims none when the object id matches several, and logs no email", async () => {
    const { provider, connection, domain } = await scimProvider();
    const oid = `dup-${unique()}`;
    const first = await managedUser(connection.id, domain, oid);
    const second = await managedUser(connection.id, domain, `${oid}-2`);
    // The unique index on (connection, external_id) rules this out today; the
    // claim must still refuse to pick one.
    vi.spyOn(db.scim, "findClaimable").mockResolvedValueOnce(
      await prisma.scimUser.findMany({
        where: { userId: { in: [first.id, second.id] } },
      })
    );
    const warn = vi.spyOn(logger, "warn");

    const result = await resolveLoginIdentity(
      provider,
      identity({ objectId: oid, email: first.email, emailVerified: true })
    );
    expect(result).toEqual({ error: "no_account" });
    expect(await identitiesOf(first.id)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      { providerId: provider.id, rule: "objectId", matches: 2 },
      expect.any(String)
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(first.email);
  });

  it("does not claim a user who already has an identity at the provider, nor fall back to another", async () => {
    const { provider, connection, domain } = await scimProvider();
    const oid = `ext-${unique()}`;
    const owner = await managedUser(connection.id, domain, oid);
    await prisma.userIdentity.create({
      data: { userId: owner.id, providerId: provider.id, subject: unique() },
    });
    const other = await managedUser(connection.id, domain);

    const result = await resolveLoginIdentity(
      provider,
      identity({ objectId: oid, email: other.email, emailVerified: true })
    );
    expect(result).toEqual({ error: "no_account" });
    expect(await identitiesOf(owner.id)).toHaveLength(1);
    expect(await identitiesOf(other.id)).toEqual([]);
  });

  it("does not claim through an inactive provider", async () => {
    const { provider, connection, domain } = await scimProvider();
    const user = await managedUser(connection.id, domain);
    const result = await resolveLoginIdentity(
      { ...provider, isActive: false },
      identity({ email: user.email, emailVerified: true })
    );
    expect(result).toEqual({ error: "no_account" });
    expect(await identitiesOf(user.id)).toEqual([]);
  });

  it("holds Google to the hd rule", async () => {
    const { provider, connection, domain } = await scimProvider(GOOGLE);
    const user = await managedUser(connection.id, domain);
    const consumer = identity({ email: user.email, emailVerified: true });
    expect(await resolveLoginIdentity(provider, consumer)).toEqual({
      error: "no_account",
    });
    expect(await identitiesOf(user.id)).toEqual([]);

    const workspace = identity({
      email: user.email,
      emailVerified: true,
      hostedDomain: domain,
    });
    expect(await resolveLoginIdentity(provider, workspace)).toEqual({
      userId: user.id,
    });
  });

  it("does not claim a user of another provider's connection", async () => {
    const mine = await scimProvider();
    const theirs = await scimProvider();
    const user = await managedUser(theirs.connection.id, theirs.domain);
    const result = await resolveLoginIdentity(
      mine.provider,
      identity({ email: user.email, emailVerified: true })
    );
    expect(result).toEqual({ error: "no_account" });
    expect(await identitiesOf(user.id)).toEqual([]);
  });
});
