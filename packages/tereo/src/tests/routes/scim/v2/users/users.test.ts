// @module-tag int
// @module-tag auth
import { createScimConnection, scimFetch } from "../../../../support/scim.js";
import { makeUser, manage, tag } from "../../../../support/scimUsers.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import db from "../../../../../utils/db/index.js";
import { describe, expect, it } from "vitest";

const list = (token: string, query = "") =>
  scimFetch(token, "GET", `/scim/v2/Users${query}`);
const byUserName = (token: string, name: string) =>
  list(token, `?filter=${encodeURIComponent(`userName eq "${name}"`)}`);
const names = (body: { Resources: { userName: string }[] }) =>
  body.Resources.map((r) => r.userName);

describe("GET /scim/v2/Users", () => {
  it("lists only this connection's managed users without a filter", async () => {
    const a = await createScimConnection();
    const b = await createScimConnection();
    const mine = await makeUser(`mine-${tag()}@${a.domain}`);
    const unmanaged = await makeUser(`free-${tag()}@${a.domain}`);
    const theirs = await makeUser(`theirs-${tag()}@${b.domain}`);
    await manage(a.connectionId, mine.id, mine.email, { externalId: "x1" });
    await manage(b.connectionId, theirs.id, theirs.email);

    const { status, body } = await list(a.token);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      totalResults: 1,
      startIndex: 1,
      itemsPerPage: 1,
    });
    expect(body.Resources).toHaveLength(1);
    expect(body.Resources[0]).toMatchObject({
      id: mine.id,
      userName: mine.email,
      externalId: "x1",
    });
    expect(JSON.stringify(body)).not.toContain(unmanaged.id);
  });

  it("finds an unmanaged in-domain human by userName, rendered with its email", async () => {
    const c = await createScimConnection();
    const user = await makeUser(`free-${tag()}@${c.domain}`);
    const { body } = await byUserName(c.token, user.email);
    expect(body.totalResults).toBe(1);
    expect(body.Resources[0]).toMatchObject({
      id: user.id,
      userName: user.email,
    });
    expect(body.Resources[0]).not.toHaveProperty("externalId");
  });

  it("finds an inactive user", async () => {
    const c = await createScimConnection();
    const user = await makeUser(`off-${tag()}@${c.domain}`, {
      isActive: false,
    });
    await manage(c.connectionId, user.id, user.email);
    const { body } = await list(c.token);
    expect(body.Resources[0]).toMatchObject({ id: user.id, active: false });
  });

  it("matches userName, email and externalId", async () => {
    const c = await createScimConnection();
    const user = await makeUser(`m-${tag()}@${c.domain}`);
    await manage(c.connectionId, user.id, "Alias.Name", { externalId: "Ext1" });
    const f = (q: string) => list(c.token, `?filter=${encodeURIComponent(q)}`);
    expect((await f('userName eq "alias.name"')).body.totalResults).toBe(1);
    expect(
      (await f(`emails.value eq "${user.email.toUpperCase()}"`)).body
        .totalResults
    ).toBe(1);
    expect((await f('externalId eq "Ext1"')).body.totalResults).toBe(1);
    expect((await f('externalId eq "ext1"')).body.totalResults).toBe(0);
    expect((await f(`userName eq "${user.email}"`)).body.totalResults).toBe(0);
    expect(
      (await f(`userName eq "alias.name" and externalId eq "nope"`)).body
        .totalResults
    ).toBe(0);
  });

  it("never matches an unmanaged user by externalId", async () => {
    const c = await createScimConnection();
    await makeUser(`free-${tag()}@${c.domain}`);
    const { body } = await list(
      c.token,
      `?filter=${encodeURIComponent('externalId eq "x"')}`
    );
    expect(body.totalResults).toBe(0);
  });

  it("compares case-insensitively", async () => {
    const c = await createScimConnection();
    const user = await makeUser(`free-${tag()}@${c.domain}`);
    const { body } = await byUserName(c.token, user.email.toUpperCase());
    expect(names(body)).toEqual([user.email]);
  });

  describe("users that do not exist as far as SCIM can tell", () => {
    it("returns nothing for a guest, a service account, another domain, another connection and a deleted link", async () => {
      const c = await createScimConnection();
      const other = await createScimConnection();
      const stamp = tag();
      const guest = await makeUser(`guest-${stamp}@${c.domain}`, {
        userType: "guest",
      });
      const service = await makeUser(`svc-${stamp}@${c.domain}`, {
        userType: "service_account",
      });
      const elsewhere = await makeUser(`out-${stamp}@elsewhere-${stamp}.test`);
      const managedByOther = await makeUser(`oth-${stamp}@${c.domain}`);
      await manage(other.connectionId, managedByOther.id, managedByOther.email);
      const deletedHere = await makeUser(`del-${stamp}@${c.domain}`);
      await manage(c.connectionId, deletedHere.id, deletedHere.email, {
        deletedAt: new Date(),
      });
      const deletedElsewhere = await makeUser(`dele-${stamp}@${c.domain}`);
      await manage(
        other.connectionId,
        deletedElsewhere.id,
        deletedElsewhere.email,
        {
          deletedAt: new Date(),
        }
      );

      for (const user of [
        guest,
        service,
        elsewhere,
        managedByOther,
        deletedHere,
        deletedElsewhere,
      ]) {
        const { status, body } = await byUserName(c.token, user.email);
        expect(status).toBe(200);
        expect(body.totalResults, user.email).toBe(0);
        expect(body.Resources).toEqual([]);
      }
    });
  });

  it("does not write a row", async () => {
    const c = await createScimConnection();
    const user = await makeUser(`free-${tag()}@${c.domain}`);
    const before = await db.scim.countLinks(c.connectionId);
    await byUserName(c.token, user.email);
    await list(c.token);
    await scimFetch(c.token, "GET", `/scim/v2/Users/${user.id}`);
    expect(await db.scim.countLinks(c.connectionId)).toBe(before);
    expect(await prisma.scimUser.count({ where: { userId: user.id } })).toBe(0);
  });

  it("keeps a managed user visible after the domain row is deleted", async () => {
    const c = await createScimConnection({
      domains: [`gone-${tag()}.test`, `kept-${tag()}.test`],
    });
    const user = await makeUser(`m-${tag()}@${c.domain}`);
    await manage(c.connectionId, user.id, user.email);
    await prisma.identityProviderDomain.delete({ where: { domain: c.domain } });

    const byName = await byUserName(c.token, user.email);
    expect(byName.body.totalResults).toBe(1);
    expect((await list(c.token)).body.totalResults).toBe(1);
    const byId = await scimFetch(c.token, "GET", `/scim/v2/Users/${user.id}`);
    expect(byId.status).toBe(200);
  });

  it("rejects an unsupported filter", async () => {
    const c = await createScimConnection();
    const { status, body } = await list(
      c.token,
      `?filter=${encodeURIComponent('userName co "a"')}`
    );
    expect(status).toBe(400);
    expect(body.scimType).toBe("invalidFilter");
  });

  describe("filter values are literal text", () => {
    it("treats % and _ as ordinary characters", async () => {
      const c = await createScimConnection();
      const stamp = tag();
      const first = await makeUser(`j_smith-${stamp}@${c.domain}`);
      await makeUser(`jxsmith-${stamp}@${c.domain}`);
      const m = await makeUser(`m-${stamp}@${c.domain}`);
      await manage(c.connectionId, m.id, m.email);
      const f = (q: string) =>
        list(c.token, `?filter=${encodeURIComponent(q)}`);

      expect((await f('userName eq "%"')).body.Resources).toEqual([]);
      expect((await f('emails.value eq "%"')).body.Resources).toEqual([]);
      expect((await f('emails.value eq "_"')).body.Resources).toEqual([]);
      const { body } = await byUserName(c.token, first.email);
      expect(body.Resources.map((r: { id: string }) => r.id)).toEqual([
        first.id,
      ]);
    });

    it("does not match a domain that merely ends with or extends the provider's", async () => {
      const c = await createScimConnection();
      const stamp = tag();
      const evil = await makeUser(`x-${stamp}@evil-${c.domain}`);
      const sub = await makeUser(`x-${stamp}@sub.${c.domain}`);
      for (const user of [evil, sub]) {
        const { body } = await list(
          c.token,
          `?filter=${encodeURIComponent(`emails.value eq "${user.email}"`)}`
        );
        expect(body.totalResults, user.email).toBe(0);
      }
    });
  });
});
