// @module-tag int
// @module-tag auth
import type { NormalizedIdentity } from "../../../utils/identityProviders/types.js";
import { ensureDefaultOrganization } from "../../../utils/defaultOrganization.js";
import { createTestRole, createTestUser } from "../../support/auth/users.js";
import { ensureTestOrganization } from "../../support/principals.js";
import { SYSTEM_USER_ID } from "../../../definitions/index.js";
import { prisma } from "../../../utils/db/prisma.js";
import { manage } from "../../support/scimUsers.js";
import { logger } from "../../../utils/logger.js";
import { emitTx } from "../../../utils/outbox.js";
import db from "../../../utils/db/index.js";
import { randomBytes } from "node:crypto";
import {
  linkIdentity,
  resolveLoginIdentity,
} from "../../../utils/identityProviders/resolve.js";
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";

// Outbox rows are dispatched and deleted by the running server's reaper, so
// the emitted events are asserted at the call instead of in core.outbox.
vi.mock("../../../utils/outbox.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../utils/outbox.js")>();
  return { ...actual, emitTx: vi.fn(actual.emitTx) };
});

const DAY = 24 * 60 * 60 * 1000;
const GOOGLE = "https://accounts.google.com";
const ENTRA =
  "https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/v2.0";
const unique = () => randomBytes(8).toString("hex");

let adminId: string;

const makeProvider = (issuer = "https://idp.test.local") =>
  db.identityProviders.create({
    slug: `resolve-${unique()}`,
    displayName: "Resolve",
    kind: "oidc",
    issuer,
    clientId: "cid",
    clientSecret: "sealed",
    createdBy: adminId,
  });

const makeDomain = async (
  providerId: string,
  opts: { autoAccept?: boolean; roleIds?: string[] } = {}
) => {
  const domain = `${unique()}.example.test`;
  const organizationId = await ensureTestOrganization(`resolve-${unique()}`);
  const row = await db.identityProviders.createDomain({
    providerId,
    domain,
    organizationId,
    autoAccept: opts.autoAccept ?? true,
    createdBy: adminId,
  });
  if (opts.roleIds) {
    await db.identityProviders.setDomainRoles(row.id, opts.roleIds);
  }
  return row;
};

const identity = (
  overrides: Partial<NormalizedIdentity> = {}
): NormalizedIdentity => ({
  subject: `sub-${unique()}`,
  email: null,
  emailVerified: true,
  name: "Alice Example",
  firstName: "Alice",
  lastName: "Example",
  hostedDomain: null,
  objectId: null,
  authTime: null,
  ...overrides,
});

const invite = (userId: string, providerId: string) =>
  db.userIdentities.upsertInvite({
    userId,
    providerId,
    createdBy: adminId,
    expiresAt: new Date(Date.now() + 7 * DAY),
  });

const identitiesFor = (providerId: string, subject: string) =>
  prisma.userIdentity.findMany({ where: { providerId, subject } });

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

beforeEach(() => {
  vi.mocked(emitTx).mockClear();
});

describe("resolveLoginIdentity", () => {
  it("returns the linked user for a known subject and records the login", async () => {
    const provider = await makeProvider();
    const user = await createTestUser();
    const id = identity({ email: "Seen@Elsewhere.test" });
    const linked = await db.userIdentities.create({
      userId: user.id,
      providerId: provider.id,
      subject: id.subject,
      email: null,
    });

    expect(await resolveLoginIdentity(provider, id)).toEqual({
      userId: user.id,
    });
    const row = await prisma.userIdentity.findUniqueOrThrow({
      where: { id: linked.id },
    });
    expect(row.lastLoginAt).not.toBeNull();
    expect(row.email).toBe("seen@elsewhere.test");
  });

  it("verifies a linked user's matching email, unless the account is unusable", async () => {
    const provider = await makeProvider();
    const signIn = async (isActive: boolean) => {
      const user = await createTestUser({ emailVerified: false, isActive });
      const id = identity({ email: user.email, emailVerified: true });
      await db.userIdentities.create({
        userId: user.id,
        providerId: provider.id,
        subject: id.subject,
        email: null,
      });
      await resolveLoginIdentity(provider, id);
      return prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    };

    expect((await signIn(true)).emailVerifiedAt).not.toBeNull();
    expect((await signIn(false)).emailVerifiedAt).toBeNull();
  });

  it("claims an invite for a verified matching email", async () => {
    const provider = await makeProvider();
    const user = await createTestUser();
    await invite(user.id, provider.id);
    const id = identity({ email: user.email });

    expect(await resolveLoginIdentity(provider, id)).toEqual({
      userId: user.id,
    });
    const rows = await identitiesFor(provider.id, id.subject);
    expect(rows.map((r) => r.userId)).toEqual([user.id]);
    expect(
      await prisma.identityInvite.count({
        where: { userId: user.id, providerId: provider.id },
      })
    ).toBe(0);
    const events = vi.mocked(emitTx).mock.calls.map(([, e]) => e.eventType);
    expect(events).toEqual(["auth.user.identity-linked"]);
  });

  it("claiming an invite verifies the address only for a usable account", async () => {
    const provider = await makeProvider();
    const claim = async (isActive: boolean) => {
      const user = await createTestUser({ emailVerified: false, isActive });
      await invite(user.id, provider.id);
      await resolveLoginIdentity(provider, identity({ email: user.email }));
      return prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    };

    expect((await claim(true)).emailVerifiedAt).not.toBeNull();
    expect((await claim(false)).emailVerifiedAt).toBeNull();
  });

  it("matches an invite whatever the case of the provider's email", async () => {
    const provider = await makeProvider();
    const local = `alice-${unique()}`;
    const user = await createTestUser({ email: `${local}@acme.test` });
    await invite(user.id, provider.id);

    const result = await resolveLoginIdentity(
      provider,
      identity({ email: `  ${local.toUpperCase()}@Acme.TEST ` })
    );
    expect(result).toEqual({ userId: user.id });
  });

  it("refuses an invite when the provider did not verify the email", async () => {
    const provider = await makeProvider();
    const user = await createTestUser();
    await invite(user.id, provider.id);
    const id = identity({ email: user.email, emailVerified: false });

    expect(await resolveLoginIdentity(provider, id)).toEqual({
      error: "email_unverified",
    });
    expect(await identitiesFor(provider.id, id.subject)).toHaveLength(0);
    expect(
      await prisma.identityInvite.count({
        where: { userId: user.id, providerId: provider.id },
      })
    ).toBe(1);
  });

  it("ignores an expired invite", async () => {
    const provider = await makeProvider();
    const user = await createTestUser();
    await db.userIdentities.upsertInvite({
      userId: user.id,
      providerId: provider.id,
      createdBy: adminId,
      expiresAt: new Date(Date.now() - 1000),
    });

    expect(
      await resolveLoginIdentity(provider, identity({ email: user.email }))
    ).toEqual({ error: "no_account" });
  });

  it("provisions a new user through an auto-accept domain", async () => {
    const provider = await makeProvider();
    const role = await createTestRole();
    const domain = await makeDomain(provider.id, { roleIds: [role.id] });
    const email = `new-${unique()}@${domain.domain}`;
    const id = identity({ email });

    const result = await resolveLoginIdentity(provider, id);
    expect(result).toHaveProperty("userId");
    const { userId } = result as { userId: string };

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user).toMatchObject({
      email,
      passwordHash: null,
      name: "Alice Example",
      firstName: "Alice",
      lastName: "Example",
      userType: "human",
      isActive: true,
    });

    const membership = await db.organizations.getMembership(
      domain.organizationId,
      userId
    );
    expect(membership?.memberRole).toBe("member");
    const roles = await db.organizations.getMemberRoles(
      domain.organizationId,
      userId
    );
    expect(roles.map((r) => r.roleId)).toEqual([role.id]);

    const rows = await identitiesFor(provider.id, id.subject);
    expect(rows.map((r) => r.userId)).toEqual([userId]);

    const events = vi.mocked(emitTx).mock.calls.map(([, e]) => e);
    expect(events.map((e) => e.eventType)).toEqual([
      "auth.user.created",
      "auth.organization.member-added",
      "auth.organization.member-roles-changed",
      "auth.user.identity-linked",
      "auth.user.email-verified",
    ]);
    expect(events[1].data).toMatchObject({
      organizationId: domain.organizationId,
      userId,
      email,
      memberRole: "member",
    });
    expect(events[2].data).toMatchObject({
      organizationId: domain.organizationId,
      userId,
      roleIds: [role.id],
    });
    expect(events[3].data).toMatchObject({
      userId,
      providerId: provider.id,
      email,
    });

    const audit = await prisma.auditLogEntry.findMany({
      where: { userId: SYSTEM_USER_ID, entityName: email },
    });
    expect(audit.map((a) => a.entityType).sort()).toEqual([
      "OrganizationMember",
      "OrganizationMember",
      "User",
      "User",
      "UserIdentity",
    ]);
  });

  it("provisions without a roles change when the domain has no default roles", async () => {
    const provider = await makeProvider();
    const domain = await makeDomain(provider.id);
    const result = await resolveLoginIdentity(
      provider,
      identity({ email: `bare-${unique()}@${domain.domain}` })
    );
    expect(result).toHaveProperty("userId");
    const events = vi.mocked(emitTx).mock.calls.map(([, e]) => e.eventType);
    expect(events).toEqual([
      "auth.user.created",
      "auth.organization.member-added",
      "auth.user.identity-linked",
      "auth.user.email-verified",
    ]);
  });

  it("refuses account_exists when an auto-accept domain's email already has a user", async () => {
    const provider = await makeProvider();
    const domain = await makeDomain(provider.id);
    const existing = await createTestUser({
      email: `taken-${unique()}@${domain.domain}`,
    });
    const id = identity({ email: existing.email.toUpperCase() });

    expect(await resolveLoginIdentity(provider, id)).toEqual({
      error: "account_exists",
    });
    expect(await identitiesFor(provider.id, id.subject)).toHaveLength(0);
    expect(
      await prisma.userIdentity.count({ where: { userId: existing.id } })
    ).toBe(0);
  });

  it("refuses an auto-accept domain when the provider did not verify the email", async () => {
    const provider = await makeProvider();
    const domain = await makeDomain(provider.id);
    const email = `unverified-${unique()}@${domain.domain}`;

    expect(
      await resolveLoginIdentity(
        provider,
        identity({ email, emailVerified: false })
      )
    ).toEqual({ error: "email_unverified" });
    expect(await db.users.getByEmail(email)).toBeNull();
  });

  it("does not provision through a domain without auto-accept", async () => {
    const provider = await makeProvider();
    const domain = await makeDomain(provider.id, { autoAccept: false });
    const email = `closed-${unique()}@${domain.domain}`;

    expect(await resolveLoginIdentity(provider, identity({ email }))).toEqual({
      error: "no_account",
    });
    expect(await db.users.getByEmail(email)).toBeNull();
  });

  it("does not provision through another provider's domain", async () => {
    const provider = await makeProvider();
    const other = await makeProvider();
    const domain = await makeDomain(other.id);
    const email = `mixup-${unique()}@${domain.domain}`;

    expect(await resolveLoginIdentity(provider, identity({ email }))).toEqual({
      error: "no_account",
    });
    expect(await db.users.getByEmail(email)).toBeNull();
  });

  it("refuses no_account without a link, invite or domain", async () => {
    const provider = await makeProvider();
    expect(
      await resolveLoginIdentity(
        provider,
        identity({ email: `nobody-${unique()}@nowhere.test` })
      )
    ).toEqual({ error: "no_account" });
    expect(await resolveLoginIdentity(provider, identity())).toEqual({
      error: "no_account",
    });
  });

  it("does not link an existing account by email alone", async () => {
    const provider = await makeProvider();
    const user = await createTestUser();
    const id = identity({ email: user.email });

    expect(await resolveLoginIdentity(provider, id)).toEqual({
      error: "no_account",
    });
    expect(
      await prisma.userIdentity.count({ where: { userId: user.id } })
    ).toBe(0);
  });

  describe("Google", () => {
    it("refuses a domain match without hd", async () => {
      const provider = await makeProvider(GOOGLE);
      const domain = await makeDomain(provider.id);
      const email = `nohd-${unique()}@${domain.domain}`;

      expect(await resolveLoginIdentity(provider, identity({ email }))).toEqual(
        { error: "email_unverified" }
      );
      expect(await db.users.getByEmail(email)).toBeNull();
    });

    it("refuses a domain match whose hd is another domain", async () => {
      const provider = await makeProvider(GOOGLE);
      const domain = await makeDomain(provider.id);
      const email = `otherhd-${unique()}@${domain.domain}`;

      expect(
        await resolveLoginIdentity(
          provider,
          identity({ email, hostedDomain: "elsewhere.test" })
        )
      ).toEqual({ error: "email_unverified" });
    });

    it("accepts a domain match whose hd equals the email's domain", async () => {
      const provider = await makeProvider(GOOGLE);
      const domain = await makeDomain(provider.id);
      const email = `hd-${unique()}@${domain.domain}`;

      const result = await resolveLoginIdentity(
        provider,
        identity({ email, hostedDomain: domain.domain })
      );
      expect(result).toEqual({
        userId: (await db.users.getByEmail(email))?.id,
      });
    });

    it("refuses an invite for a Workspace-domain address without hd", async () => {
      const provider = await makeProvider(GOOGLE);
      const user = await createTestUser({ email: `ws-${unique()}@acme.test` });
      await invite(user.id, provider.id);

      expect(
        await resolveLoginIdentity(provider, identity({ email: user.email }))
      ).toEqual({ error: "email_unverified" });
    });

    it("accepts an invite for a gmail.com address, which carries no hd", async () => {
      const provider = await makeProvider(GOOGLE);
      const user = await createTestUser({ email: `g-${unique()}@gmail.com` });
      await invite(user.id, provider.id);

      expect(
        await resolveLoginIdentity(provider, identity({ email: user.email }))
      ).toEqual({ userId: user.id });
    });

    it("does not auto-accept a gmail.com domain", async () => {
      const provider = await makeProvider(GOOGLE);
      const organizationId = await ensureTestOrganization(`gm-${unique()}`);
      const existing = await prisma.identityProviderDomain.findUnique({
        where: { domain: "gmail.com" },
      });
      // gmail.com is globally unique; another run may already hold it.
      if (existing)
        await prisma.identityProviderDomain.delete({
          where: { id: existing.id },
        });
      await db.identityProviders.createDomain({
        providerId: provider.id,
        domain: "gmail.com",
        organizationId,
        autoAccept: true,
        createdBy: adminId,
      });
      const email = `auto-${unique()}@gmail.com`;
      try {
        expect(
          await resolveLoginIdentity(provider, identity({ email }))
        ).toEqual({ error: "email_unverified" });
        expect(await db.users.getByEmail(email)).toBeNull();
      } finally {
        await prisma.identityProviderDomain.deleteMany({
          where: { domain: "gmail.com" },
        });
      }
    });
  });

  it("refuses an invite for a user already linked at this provider, keeping the invite", async () => {
    const provider = await makeProvider();
    const user = await createTestUser();
    await db.userIdentities.create({
      userId: user.id,
      providerId: provider.id,
      subject: `earlier-${unique()}`,
      email: user.email,
    });
    await invite(user.id, provider.id);
    const id = identity({ email: user.email });

    expect(await resolveLoginIdentity(provider, id)).toEqual({
      error: "account_exists",
    });
    expect(await identitiesFor(provider.id, id.subject)).toHaveLength(0);
    expect(
      await prisma.identityInvite.count({
        where: { userId: user.id, providerId: provider.id },
      })
    ).toBe(1);
  });

  it.each([
    ["archived", { archivedAt: new Date() }],
    ["inactive", { isActive: false }],
  ])("does not provision into an %s organization", async (_label, frozen) => {
    const provider = await makeProvider();
    const domain = await makeDomain(provider.id);
    await prisma.organization.update({
      where: { id: domain.organizationId },
      data: frozen,
    });
    const email = `frozen-${unique()}@${domain.domain}`;

    expect(await resolveLoginIdentity(provider, identity({ email }))).toEqual({
      error: "no_account",
    });
    expect(await db.users.getByEmail(email)).toBeNull();
  });
});

describe("linkIdentity", () => {
  it("links, removes the provider's invite, audits as the actor and emits", async () => {
    const provider = await makeProvider();
    const user = await createTestUser();
    await invite(user.id, provider.id);
    const id = identity({ email: "Linked@Example.TEST" });

    await db.$transaction((tx) =>
      linkIdentity(
        tx,
        { userId: user.id, email: user.email },
        user.id,
        provider,
        id
      )
    );

    const [row] = await identitiesFor(provider.id, id.subject);
    expect(row).toMatchObject({
      userId: user.id,
      email: "linked@example.test",
    });
    expect(
      await prisma.identityInvite.count({
        where: { userId: user.id, providerId: provider.id },
      })
    ).toBe(0);
    const audit = await prisma.auditLogEntry.findFirst({
      where: { entityType: "UserIdentity", entityId: row.id },
    });
    expect(audit?.userId).toBe(user.id);
    const [[, event]] = vi.mocked(emitTx).mock.calls;
    expect(event).toMatchObject({
      eventType: "auth.user.identity-linked",
      entityType: "UserIdentity",
      entityId: row.id,
      data: {
        userId: user.id,
        providerId: provider.id,
        provider: provider.slug,
      },
    });
  });
});

describe("resolveLoginIdentity claiming a SCIM user", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("claims by Entra object id without a verified email", async () => {
    const { provider, connection, domain } = await scimProvider();
    const oid = randomBytes(16).toString("hex");
    const user = await managedUser(connection.id, domain, oid);
    const id = identity({
      objectId: oid,
      email: user.email,
      emailVerified: false,
    });

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

  it.each([
    ["a deactivated", { isActive: false }],
    [
      "an expired guest",
      { userType: "guest" as const, expiresAt: new Date(Date.now() - 60_000) },
    ],
  ])(
    "names %s managed user for the caller to refuse, linking nothing",
    async (_, standing) => {
      const { provider, connection, domain } = await scimProvider();
      const user = await managedUser(connection.id, domain);
      await prisma.user.update({ where: { id: user.id }, data: standing });

      const result = await resolveLoginIdentity(
        provider,
        identity({ email: user.email, emailVerified: true })
      );
      expect(result).toEqual({ userId: user.id });
      expect(await identitiesOf(user.id)).toEqual([]);
    }
  );

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
