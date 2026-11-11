// @module-tag int
// @module-tag auth
import { ensureTestUser } from "../../support/principals.js";
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../../../utils/db/prisma.js";
import db from "../../../utils/db/index.js";
import { randomUUID } from "node:crypto";

const run = randomUUID().slice(0, 8);

let actorId: string;

const makeProvider = async (label: string) =>
  await db.identityProviders.create({
    slug: `scim-${label}-${run}`,
    displayName: label,
    kind: "oidc",
    issuer: "https://idp.example.com",
    clientId: "client",
    clientSecret: "sealed",
    createdBy: actorId,
  });

const makeConnection = async (label: string) => {
  const provider = await makeProvider(label);
  return await db.$transaction((tx) =>
    db.scim.createConnection(
      { providerId: provider.id, createdBy: actorId },
      tx
    )
  );
};

const makeUser = async () => await ensureTestUser(randomUUID());

const link = async (
  connectionId: string,
  userName: string,
  externalId: string | null
) =>
  await db.$transaction(async (tx) =>
    db.scim.createLink(
      {
        connectionId,
        userId: await makeUser(),
        externalId,
        userName,
        idpActive: true,
        adminHold: false,
      },
      tx
    )
  );

describe("db.scim", () => {
  beforeAll(async () => {
    actorId = await ensureTestUser(randomUUID());
  });

  it("allows one connection per provider", async () => {
    const connection = await makeConnection("one-per");
    await expect(
      db.$transaction((tx) =>
        db.scim.createConnection(
          { providerId: connection.providerId, createdBy: actorId },
          tx
        )
      )
    ).rejects.toThrow();
  });

  it("rejects user names that differ only in case", async () => {
    const connection = await makeConnection("case");
    await link(connection.id, `Alice-${run}@Example.com`, null);
    await expect(
      link(connection.id, `alice-${run}@example.com`, null)
    ).rejects.toThrow();
  });

  it("allows several links without an external id", async () => {
    const connection = await makeConnection("null-ext");
    await link(connection.id, `a-${run}`, null);
    await link(connection.id, `b-${run}`, null);
    expect(await db.scim.countLinks(connection.id)).toBe(2);
  });

  it("rejects a repeated external id within a connection", async () => {
    const connection = await makeConnection("ext");
    await link(connection.id, `a-${run}`, "ext-1");
    await expect(link(connection.id, `b-${run}`, "ext-1")).rejects.toThrow();
  });

  it("finds a live token but not a revoked one", async () => {
    const connection = await makeConnection("tokens");
    const hash = randomUUID().replaceAll("-", "");
    const token = await db.$transaction((tx) =>
      db.scim.createToken(
        { connectionId: connection.id, hash, createdBy: actorId },
        tx
      )
    );
    const found = await db.scim.findLiveToken(hash);
    expect(found?.id).toBe(token.id);
    expect(found?.connection.provider.id).toBe(connection.providerId);

    await db.$transaction((tx) =>
      db.scim.revokeToken(connection.id, token.id, tx)
    );
    expect(await db.scim.findLiveToken(hash)).toBeNull();
  });

  it("touches a connection at most once a minute", async () => {
    const connection = await makeConnection("touch");
    const token = await db.$transaction((tx) =>
      db.scim.createToken(
        {
          connectionId: connection.id,
          hash: randomUUID().replaceAll("-", ""),
          createdBy: actorId,
        },
        tx
      )
    );
    await db.scim.touchConnection(connection.id, token.id);
    const first = await prisma.scimConnection.findUniqueOrThrow({
      where: { id: connection.id },
    });
    await db.scim.touchConnection(connection.id, token.id);
    const second = await prisma.scimConnection.findUniqueOrThrow({
      where: { id: connection.id },
    });
    expect(first.lastUsedAt).not.toBeNull();
    expect(second.lastUsedAt).toEqual(first.lastUsedAt);
  });

  it("claims by email as a true case-insensitive equality", async () => {
    const connection = await makeConnection("claim");
    const wanted = await prisma.user.create({
      data: { email: `j_smith-${run}@claim.test` },
    });
    const lookalike = await prisma.user.create({
      data: { email: `jxsmith-${run}@claim.test` },
    });
    for (const user of [wanted, lookalike]) {
      await db.$transaction((tx) =>
        db.scim.createLink(
          {
            connectionId: connection.id,
            userId: user.id,
            externalId: null,
            userName: user.email,
            idpActive: true,
            adminHold: false,
          },
          tx
        )
      );
    }
    const found = await db.scim.findClaimable(connection.id, {
      email: wanted.email.toUpperCase(),
    });
    expect(found.map((l) => l.userId)).toEqual([wanted.id]);
    expect(await db.scim.findClaimable(connection.id, { email: "%" })).toEqual(
      []
    );
  });
});
