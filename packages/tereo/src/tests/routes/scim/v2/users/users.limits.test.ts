// @module-tag int
// @module-tag auth
import { createScimConnection, scimFetch } from "../../../../support/scim.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import { tag } from "../../../../support/scimUsers.js";
import { describe, expect, it } from "vitest";

const seed = async (total: number) => {
  const c = await createScimConnection();
  const stamp = tag();
  const users = Array.from({ length: total }, (_, i) => ({
    email: `p${i}-${stamp}@${c.domain}`,
    name: `P ${i}`,
  }));
  await prisma.user.createMany({ data: users });
  const rows = await prisma.user.findMany({
    where: { email: { in: users.map((u) => u.email) } },
  });
  await prisma.scimUser.createMany({
    data: rows.map((u) => ({
      connectionId: c.connectionId,
      userId: u.id,
      userName: u.email,
      userNameKey: u.email,
      idpActive: true,
    })),
  });
  return { c, ids: rows.map((u) => u.id).sort() };
};

const get = (token: string, query: string) =>
  scimFetch(token, "GET", `/scim/v2/Users?${query}`);

describe("GET /scim/v2/Users pagination", () => {
  it("count=0 returns no resources and the real total", async () => {
    const { c } = await seed(3);
    const { status, body } = await get(c.token, "count=0");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      totalResults: 3,
      startIndex: 1,
      itemsPerPage: 0,
      Resources: [],
    });
  });

  it("startIndex past the end returns no resources and the real total", async () => {
    const { c } = await seed(3);
    const { status, body } = await get(c.token, "startIndex=9999");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      totalResults: 3,
      startIndex: 9999,
      itemsPerPage: 0,
      Resources: [],
    });
  });

  it("treats startIndex=0 as 1 and orders by user id", async () => {
    const { c, ids } = await seed(3);
    const { body } = await get(c.token, "startIndex=0");
    expect(body.startIndex).toBe(1);
    expect(body.Resources.map((r: { id: string }) => r.id)).toEqual(ids);
  });

  it("pages with startIndex and count", async () => {
    const { c, ids } = await seed(3);
    const { body } = await get(c.token, "startIndex=2&count=1");
    expect(body).toMatchObject({
      totalResults: 3,
      startIndex: 2,
      itemsPerPage: 1,
    });
    expect(body.Resources.map((r: { id: string }) => r.id)).toEqual([ids[1]]);
  });

  it("caps count at 200", async () => {
    const { c } = await seed(201);
    const { body } = await get(c.token, "count=500");
    expect(body.itemsPerPage).toBe(200);
    expect(body.Resources).toHaveLength(200);
    expect(body.totalResults).toBe(201);
  });

  it("defaults count to 100", async () => {
    const { c } = await seed(101);
    const { body } = await get(c.token, "");
    expect(body.itemsPerPage).toBe(100);
  });

  it.each(["count=-1", "count=abc", "startIndex=1.5"])(
    "rejects %s with 400 invalidValue",
    async (query) => {
      const { c } = await seed(1);
      const { status, body } = await get(c.token, query);
      expect(status).toBe(400);
      expect(body.scimType).toBe("invalidValue");
    }
  );
});
