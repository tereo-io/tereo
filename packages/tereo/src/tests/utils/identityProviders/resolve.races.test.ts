// @module-tag int
// @module-tag auth
// @module-tag race
import type { NormalizedIdentity } from "../../../utils/identityProviders/types.js";
import { resolveLoginIdentity } from "../../../utils/identityProviders/resolve.js";
import { ensureDefaultOrganization } from "../../../utils/defaultOrganization.js";
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { ensureTestOrganization } from "../../support/principals.js";
import { createTestUser } from "../../support/auth.js";
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
  });

  describe("concurrent first sign-ins of two subjects with one email", () => {
    it("claim an invite once: one user, one account_exists", async () => {
      const provider = await makeProvider();
      const user = await createTestUser();
      await invite(user.id, provider.id);

      const results = await Promise.all([
        resolveLoginIdentity(provider, identity({ email: user.email })),
        resolveLoginIdentity(provider, identity({ email: user.email })),
      ]);

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
});
