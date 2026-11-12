// @module-tag int
// @module-tag auth
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../../../utils/db/prisma.js";
import db from "../../../utils/db/index.js";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  ensureTestOrganization,
  ensureTestUser,
} from "../../support/principals.js";

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

  it("claims by the user's core email, not the SCIM user name", async () => {
    const connection = await makeConnection("claim-core-email");
    const user = await prisma.user.create({
      data: { email: `core-${run}@claim.test` },
    });
    await prisma.scimUser.create({
      data: {
        connectionId: connection.id,
        userId: user.id,
        userName: `upn-${run}@claim.test`,
        userNameKey: `upn-${run}@claim.test`,
        idpActive: true,
      },
    });
    const byEmail = await db.scim.findClaimable(connection.id, {
      email: user.email,
    });
    expect(byEmail.map((l) => l.userId)).toEqual([user.id]);
    expect(
      await db.scim.findClaimable(connection.id, {
        email: `upn-${run}@claim.test`,
      })
    ).toEqual([]);
  });

  it("never returns a deleted link", async () => {
    const connection = await makeConnection("claim-deleted");
    const user = await prisma.user.create({
      data: { email: `deleted-${run}@claim.test` },
    });
    await prisma.scimUser.create({
      data: {
        connectionId: connection.id,
        userId: user.id,
        userName: user.email,
        userNameKey: user.email,
        externalId: `ext-${run}`,
        idpActive: false,
        deletedAt: new Date(),
      },
    });
    expect(
      await db.scim.findClaimable(connection.id, { email: user.email })
    ).toEqual([]);
    expect(
      await db.scim.findClaimable(connection.id, { externalId: `ext-${run}` })
    ).toEqual([]);
  });

  it("keeps the user name's lower-cased key with the name", async () => {
    const connection = await makeConnection("key");
    const row = await link(connection.id, `Mixed-${run}@Example.com`, null);
    expect(row.userNameKey).toBe(`mixed-${run}@example.com`);
    const updated = await db.$transaction((tx) =>
      db.scim.updateLink(row.id, { userName: `Other-${run}` }, tx)
    );
    expect(updated.userNameKey).toBe(`other-${run}`);
  });

  describe("lookups by exact value", () => {
    // Under enable_seqscan = off a plan names an index only when one fits.
    const plan = async (sql: string, ...values: unknown[]) =>
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
        const rows = await tx.$queryRawUnsafe<{ "QUERY PLAN": string }[]>(
          `EXPLAIN ${sql}`,
          ...values
        );
        return rows.map((r) => r["QUERY PLAN"]).join("\n");
      });

    it("can find a user by email through users_email_key", async () => {
      expect(
        await plan(
          `SELECT * FROM "auth"."users" WHERE "email" = $1`,
          `x-${run}@example.com`
        )
      ).toContain("users_email_key");
    });

    it("can find a link by user name through its connection's key index", async () => {
      expect(
        await plan(
          `SELECT * FROM "auth"."scim_users" WHERE "connection_id" = $1::uuid AND "user_name_key" = $2`,
          randomUUID(),
          `x-${run}`
        )
      ).toContain("scim_users_connection_user_name_key");
    });

    it("can find a link by external id through its connection's partial index", async () => {
      expect(
        await plan(
          `SELECT * FROM "auth"."scim_users" WHERE "connection_id" = $1::uuid AND "external_id" = $2`,
          randomUUID(),
          `x-${run}`
        )
      ).toContain("scim_users_connection_external_id_key");
    });

    it("compares with plain equality only", async () => {
      const source = await readFile(
        new URL("../../../utils/db/scim.ts", import.meta.url),
        "utf8"
      );
      for (const pattern of [
        "insensitive",
        "endsWith",
        "contains",
        "iequals",
        "escapeLike",
      ]) {
        expect(source, pattern).not.toContain(pattern);
      }
    });
  });

  it("treats an unlinked user as no longer the connection's", async () => {
    const connection = await makeConnection("unlinked");
    const domain = `unlinked-${run}.test`;
    await prisma.identityProviderDomain.create({
      data: {
        providerId: connection.providerId,
        domain,
        organizationId: await ensureTestOrganization(`scim-unlinked-${run}`),
        createdBy: actorId,
      },
    });
    const user = await prisma.user.create({
      data: { email: `u-${run}@${domain}` },
    });
    await prisma.scimUser.create({
      data: {
        connectionId: connection.id,
        userId: user.id,
        userName: user.email,
        userNameKey: user.email,
        idpActive: true,
        unlinkedAt: new Date(),
      },
    });
    const scope = {
      connectionId: connection.id,
      providerId: connection.providerId,
    };
    const page = { skip: 0, take: 10 };

    expect(await db.scim.findVisibleUser(scope, user.id)).toBeNull();
    for (const filter of [
      [],
      [{ attr: "userName" as const, value: user.email }],
      [{ attr: "email" as const, value: user.email }],
    ]) {
      const listed = await db.scim.listVisibleUsers(scope, filter, page);
      expect(listed.total, JSON.stringify(filter)).toBe(0);
    }
    expect(
      await db.scim.findClaimable(connection.id, { email: user.email })
    ).toEqual([]);
    expect(
      await db.scim.findLiveConflict(connection.id, {
        email: user.email,
        userName: `other-${run}`,
        externalId: null,
      })
    ).toBeNull();
    expect(await db.scim.countLinks(connection.id)).toBe(0);
  });
});
