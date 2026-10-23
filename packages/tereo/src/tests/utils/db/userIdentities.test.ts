// @module-tag int
// @module-tag auth
import { createTestUser } from "../../support/auth/users.js";
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../../../utils/db/prisma.js";
import db from "../../../utils/db/index.js";
import { randomBytes } from "node:crypto";

const DAY = 24 * 60 * 60 * 1000;
const unique = () => randomBytes(16).toString("hex");

let userId: string;

const makeProvider = () =>
  db.identityProviders.create({
    slug: `store-${unique().slice(0, 12)}`,
    displayName: "Store",
    kind: "oidc",
    issuer: "https://idp.test.local",
    clientId: "cid",
    clientSecret: "sealed",
    createdBy: userId,
  });

beforeAll(async () => {
  userId = (await createTestUser()).id;
});

describe("db.userIdentities", () => {
  describe("identity invites", () => {
    it("upsertInvite twice leaves one row with the later expiry", async () => {
      const provider = await makeProvider();
      const invited = await createTestUser();
      const sooner = new Date(Date.now() + DAY);
      const later = new Date(Date.now() + 7 * DAY);

      await db.userIdentities.upsertInvite({
        userId: invited.id,
        providerId: provider.id,
        createdBy: userId,
        expiresAt: sooner,
      });
      await db.userIdentities.upsertInvite({
        userId: invited.id,
        providerId: provider.id,
        createdBy: userId,
        expiresAt: later,
      });

      const rows = await prisma.identityInvite.findMany({
        where: { userId: invited.id, providerId: provider.id },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].expiresAt.getTime()).toBe(later.getTime());
    });
  });
});
