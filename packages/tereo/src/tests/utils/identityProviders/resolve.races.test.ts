// @module-tag int
// @module-tag auth
// @module-tag race
import type { NormalizedIdentity } from "../../../utils/identityProviders/types.js";
import { resolveLoginIdentity } from "../../../utils/identityProviders/resolve.js";
import { ensureDefaultOrganization } from "../../../utils/defaultOrganization.js";
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { holdLocks, waitForLockWait } from "../../support/dbLocks.js";
import { ensureTestOrganization } from "../../support/principals.js";
import { createTestUser } from "../../support/auth/users.js";
import { prisma } from "../../../utils/db/prisma.js";
import { emitTx } from "../../../utils/outbox.js";
import db from "../../../utils/db/index.js";
import { randomBytes } from "node:crypto";

// Outbox rows are dispatched and deleted by the running server's reaper, so
// the emitted events are asserted at the call instead of in core.outbox.
vi.mock("../../../utils/outbox.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../utils/outbox.js")>();
  return { ...actual, emitTx: vi.fn(actual.emitTx) };
});

const DAY = 24 * 60 * 60 * 1000;
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

beforeAll(async () => {
  await ensureDefaultOrganization();
  adminId = (await createTestUser()).id;
});

beforeEach(() => {
  vi.mocked(emitTx).mockClear();
});

describe("resolveLoginIdentity", () => {
  describe("concurrent first sign-ins of one subject", () => {
    it("provision one user through a domain, and neither call throws", async () => {
      const provider = await makeProvider();
      const domain = await makeDomain(provider.id);
      const email = `race-${unique()}@${domain.domain}`;
      const id = identity({ email });

      const results = await Promise.all([
        resolveLoginIdentity(provider, id),
        resolveLoginIdentity(provider, id),
      ]);

      const user = await db.users.getByEmail(email);
      expect(user).not.toBeNull();
      expect(await prisma.user.count({ where: { email } })).toBe(1);
      for (const r of results) {
        expect([
          { userId: user!.id },
          { error: "account_exists" },
        ]).toContainEqual(r);
      }
      expect(results).toContainEqual({ userId: user!.id });
      expect(await identitiesFor(provider.id, id.subject)).toHaveLength(1);
    });

    it("claim an invite once, and both return the user", async () => {
      const provider = await makeProvider();
      const user = await createTestUser();
      await invite(user.id, provider.id);
      const id = identity({ email: user.email });

      const results = await Promise.all([
        resolveLoginIdentity(provider, id),
        resolveLoginIdentity(provider, id),
      ]);

      expect(results).toEqual([{ userId: user.id }, { userId: user.id }]);
      expect(await identitiesFor(provider.id, id.subject)).toHaveLength(1);
    });

    it("signs in a subject whose invite a concurrent sign-in claimed after its first lookup", async () => {
      const provider = await makeProvider();
      const user = await createTestUser();
      await invite(user.id, provider.id);
      const id = identity({ email: user.email });
      expect(await resolveLoginIdentity(provider, id)).toEqual({
        userId: user.id,
      });

      // As if the other sign-in committed its link between this one's
      // lookup by subject and its invite check.
      const lookup = vi
        .spyOn(db.userIdentities, "getByProviderSubject")
        .mockResolvedValueOnce(null);
      // The invite as that lookup's moment saw it, before the claim.
      const findInvite = vi
        .spyOn(db.userIdentities, "findInvite")
        .mockResolvedValueOnce({
          userId: user.id,
          user: { email: user.email },
        } as never);
      try {
        expect(await resolveLoginIdentity(provider, id)).toEqual({
          userId: user.id,
        });
        expect(lookup).toHaveBeenCalledTimes(2);
      } finally {
        lookup.mockRestore();
        findInvite.mockRestore();
      }
    });

    it("signs in a subject whose invite a concurrent sign-in claimed before its invite check", async () => {
      const provider = await makeProvider();
      const user = await createTestUser();
      await invite(user.id, provider.id);
      const id = identity({ email: user.email });
      expect(await resolveLoginIdentity(provider, id)).toEqual({
        userId: user.id,
      });

      // As if the other sign-in committed its link, and with it deleted the
      // invite, between this one's lookup by subject and its invite check.
      const lookup = vi
        .spyOn(db.userIdentities, "getByProviderSubject")
        .mockResolvedValueOnce(null);
      try {
        expect(await resolveLoginIdentity(provider, id)).toEqual({
          userId: user.id,
        });
      } finally {
        lookup.mockRestore();
      }
    });
  });

  describe("concurrent first sign-ins of two subjects with one email", () => {
    it("claim an invite once: one user, one account_exists", async () => {
      const provider = await makeProvider();
      const user = await createTestUser();
      await invite(user.id, provider.id);

      // Claiming deletes the invite, so a sign-in that looks it up after the
      // other committed finds none and answers no_account. Hold each lookup
      // until both have run: both see the invite, and the loser is the one
      // that finds it taken.
      const realFindInvite = db.userIdentities.findInvite;
      let looked = 0;
      let bothLooked!: () => void;
      const gate = new Promise<void>((resolve) => (bothLooked = resolve));
      const lookup = vi
        .spyOn(db.userIdentities, "findInvite")
        .mockImplementation(async (...args) => {
          const found = await realFindInvite(...args);
          if (++looked === 2) bothLooked();
          await gate;
          return found;
        });

      let results;
      try {
        results = await Promise.all([
          resolveLoginIdentity(provider, identity({ email: user.email })),
          resolveLoginIdentity(provider, identity({ email: user.email })),
        ]);
      } finally {
        lookup.mockRestore();
      }

      expect(results).toHaveLength(2);
      expect(results).toContainEqual({ userId: user.id });
      expect(results).toContainEqual({ error: "account_exists" });
      expect(
        await prisma.userIdentity.count({
          where: { userId: user.id, providerId: provider.id },
        })
      ).toBe(1);
    });

    it("provision one user through a domain: one user, one account_exists", async () => {
      const provider = await makeProvider();
      const domain = await makeDomain(provider.id);
      const email = `race2-${unique()}@${domain.domain}`;

      const results = await Promise.all([
        resolveLoginIdentity(provider, identity({ email })),
        resolveLoginIdentity(provider, identity({ email })),
      ]);

      const user = await db.users.getByEmail(email);
      expect(await prisma.user.count({ where: { email } })).toBe(1);
      expect(results).toContainEqual({ userId: user!.id });
      expect(results).toContainEqual({ error: "account_exists" });
      expect(
        await prisma.userIdentity.count({ where: { userId: user!.id } })
      ).toBe(1);
    });
  });

  describe("concurrent first sign-ins claiming one SCIM user", () => {
    /** A managed user of a provider's active SCIM connection. */
    const scimUser = async () => {
      const provider = await makeProvider();
      const domain = await makeDomain(provider.id, { autoAccept: false });
      const connection = await prisma.scimConnection.create({
        data: { providerId: provider.id, createdBy: adminId },
      });
      const user = await createTestUser({
        email: `scim-${unique()}@${domain.domain}`,
      });
      await prisma.scimUser.create({
        data: {
          connectionId: connection.id,
          userId: user.id,
          userName: user.email,
          userNameKey: user.email,
          idpActive: true,
        },
      });
      return { provider, user };
    };

    /** Holds each lookup until both have run, so both find the user unclaimed. */
    const bothFindTheLink = () => {
      const real = db.scim.findClaimable;
      let looked = 0;
      let bothLooked!: () => void;
      const gate = new Promise<void>((resolve) => (bothLooked = resolve));
      return vi
        .spyOn(db.scim, "findClaimable")
        .mockImplementation(async (...args) => {
          const found = await real(...args);
          if (++looked === 2) bothLooked();
          await gate;
          return found;
        });
    };

    it("link one subject once, and both sign in", async () => {
      const { provider, user } = await scimUser();
      const id = identity({ email: user.email });

      const lookup = bothFindTheLink();
      let results;
      try {
        results = await Promise.all([
          resolveLoginIdentity(provider, id),
          resolveLoginIdentity(provider, id),
        ]);
      } finally {
        lookup.mockRestore();
      }

      expect(results).toEqual([{ userId: user.id }, { userId: user.id }]);
      expect(await identitiesFor(provider.id, id.subject)).toHaveLength(1);
    });

    /**
     * Starts a first sign-in while `change` is committed under the user's
     * row lock, and releases it once the claim waits for that lock.
     */
    const claimDuring = async (
      user: { id: string; email: string },
      provider: Awaited<ReturnType<typeof makeProvider>>,
      change: (
        tx: Parameters<Parameters<typeof holdLocks>[0]>[0]
      ) => Promise<unknown>
    ) => {
      const release = await holdLocks(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "auth"."users" WHERE id = ${user.id}::uuid FOR UPDATE`;
        await change(tx);
      });
      const result = resolveLoginIdentity(
        provider,
        identity({ email: user.email })
      );
      try {
        // The claim's own lock, or (without it) its identity insert's key
        // lock on the user row.
        await waitForLockWait('%"auth"."user%');
      } finally {
        await release();
      }
      return await result;
    };

    it("links nothing to a user deactivated while the claim waits for the lock", async () => {
      const { provider, user } = await scimUser();
      const result = await claimDuring(user, provider, async (tx) => {
        await tx.user.update({
          where: { id: user.id },
          data: { isActive: false },
        });
        await tx.scimUser.update({
          where: { userId: user.id },
          data: { idpActive: false },
        });
      });
      expect(result).toEqual({ userId: user.id });
      expect(
        await prisma.userIdentity.count({ where: { userId: user.id } })
      ).toBe(0);
    });

    it("links nothing to a user unlinked or deleted while the claim waits for the lock", async () => {
      for (const data of [
        { unlinkedAt: new Date() },
        { deletedAt: new Date(), idpActive: false },
      ]) {
        const { provider, user } = await scimUser();
        await claimDuring(user, provider, (tx) =>
          tx.scimUser.update({ where: { userId: user.id }, data })
        );
        expect(
          await prisma.userIdentity.count({ where: { userId: user.id } }),
          JSON.stringify(data)
        ).toBe(0);
      }
    });

    it("links nothing once the connection is paused while the claim waits for the lock", async () => {
      const { provider, user } = await scimUser();
      await claimDuring(user, provider, (tx) =>
        tx.scimConnection.update({
          where: { providerId: provider.id },
          data: { isActive: false },
        })
      );
      expect(
        await prisma.userIdentity.count({ where: { userId: user.id } })
      ).toBe(0);
    });

    it("link one of two subjects: one user, one account_exists", async () => {
      const { provider, user } = await scimUser();

      const lookup = bothFindTheLink();
      let results;
      try {
        results = await Promise.all([
          resolveLoginIdentity(provider, identity({ email: user.email })),
          resolveLoginIdentity(provider, identity({ email: user.email })),
        ]);
      } finally {
        lookup.mockRestore();
      }

      expect(results).toContainEqual({ userId: user.id });
      expect(results).toContainEqual({ error: "account_exists" });
      expect(
        await prisma.userIdentity.count({
          where: { userId: user.id, providerId: provider.id },
        })
      ).toBe(1);
    });
  });
});
