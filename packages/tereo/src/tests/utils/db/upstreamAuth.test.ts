// @module-tag int
// @module-tag auth
import { createTestUser } from "../../support/auth/users.js";
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../../../utils/db/prisma.js";
import db from "../../../utils/db/index.js";
import { randomBytes } from "node:crypto";

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

const makeSession = (providerId: string, stateHash: string) =>
  db.upstreamAuth.createSession({
    stateHash,
    providerId,
    purpose: "login",
    nonce: unique(),
    codeVerifier: unique(),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });

beforeAll(async () => {
  userId = (await createTestUser()).id;
});

describe("db.upstreamAuth", () => {
  describe("upstream auth sessions", () => {
    it("consumeSession returns the row once and null the second time", async () => {
      const provider = await makeProvider();
      const stateHash = unique();
      const created = await makeSession(provider.id, stateHash);

      const first = await db.upstreamAuth.consumeSession(
        stateHash,
        provider.id
      );
      expect(first?.id).toBe(created.id);
      expect(await db.upstreamAuth.consumeSession(stateHash, provider.id)).toBe(
        null
      );
    });

    it("is single-use under concurrency", { tags: ["race"] }, async () => {
      const provider = await makeProvider();
      const stateHash = unique();
      await makeSession(provider.id, stateHash);

      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          db.upstreamAuth.consumeSession(stateHash, provider.id)
        )
      );
      expect(results.filter((r) => r !== null)).toHaveLength(1);
    });

    it("does not consume another provider's session", async () => {
      const provider = await makeProvider();
      const other = await makeProvider();
      const stateHash = unique();
      const created = await makeSession(provider.id, stateHash);

      expect(await db.upstreamAuth.consumeSession(stateHash, other.id)).toBe(
        null
      );
      expect(
        await prisma.upstreamAuthSession.findUnique({
          where: { id: created.id },
        })
      ).not.toBeNull();
    });
  });
});
