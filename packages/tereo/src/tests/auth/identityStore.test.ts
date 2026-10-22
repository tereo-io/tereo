import { describe, it, expect, beforeAll } from "vitest";
import { createTestUser } from "../support/auth.js";
import { prisma } from "../../utils/db/prisma.js";
import db from "../../utils/db/index.js";
import { randomBytes } from "crypto";

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

describe("upstream auth sessions", () => {
  it("consumeSession returns the row once and null the second time", async () => {
    const provider = await makeProvider();
    const stateHash = unique();
    const created = await makeSession(provider.id, stateHash);

    const first = await db.upstreamAuth.consumeSession(stateHash, provider.id);
    expect(first?.id).toBe(created.id);
    expect(await db.upstreamAuth.consumeSession(stateHash, provider.id)).toBe(
      null
    );
  });

  it("is single-use under concurrency", async () => {
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
      await prisma.upstreamAuthSession.findUnique({ where: { id: created.id } })
    ).not.toBeNull();
  });
});

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
