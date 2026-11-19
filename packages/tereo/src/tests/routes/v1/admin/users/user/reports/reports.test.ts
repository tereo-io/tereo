// @module-tag int
// @module-tag auth
import { getTestPrincipalToken } from "../../../../../../support/principals.js";
import { createTestUser } from "../../../../../../support/auth/users.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import { adminApi } from "../../../../../../support/groups.js";
import {
  HTTP_STATUS,
  NON_EXISTENT_UUID,
} from "../../../../../../support/auth/constants.js";

const userIds: string[] = [];
let reader: string;

const user = async (opts: { isActive?: boolean } = {}) => {
  const created = await createTestUser(opts);
  userIds.push(created.id);
  return created.id;
};
const link = (id: string, reportsToId: string) =>
  prisma.user.update({ where: { id }, data: { reportsToId } });

const reports = (id: string, query = "", token = reader) =>
  adminApi("GET", `/users/${id}/reports${query}`, token);

/** D <- C <- {B (inactive), E}, and A <- B. */
const tree = async () => {
  const [d, c, b, e, a] = [
    await user(),
    await user(),
    await user({ isActive: false }),
    await user(),
    await user(),
  ];
  await link(c, d);
  await link(b, c);
  await link(e, c);
  await link(a, b);
  return { d, c, b, e, a };
};

beforeAll(async () => {
  reader = await getTestPrincipalToken({ permissions: ["users.read"] });
});

afterAll(async () => {
  await prisma.user.updateMany({
    where: { id: { in: userIds } },
    data: { reportsToId: null },
  });
});

describe("GET /v1/admin/users/:id/reports", () => {
  it("lists direct reports", async () => {
    const { d, c } = await tree();
    const res = await reports(d);
    expect(res.status).toBe(HTTP_STATUS.OK);
    expect(res.body.nextCursor).toBeNull();
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      id: c,
      reportsToId: d,
      depth: 1,
      isActive: true,
    });
    expect(Object.keys(res.body.data[0]).sort()).toEqual([
      "depth",
      "email",
      "id",
      "isActive",
      "name",
      "reportsToId",
      "userType",
    ]);
  });

  it("lists everyone below, through deactivated users", async () => {
    const { d, c, b, e, a } = await tree();
    const res = await reports(d, "?transitive=true");
    expect(res.status).toBe(HTTP_STATUS.OK);
    const byId = new Map(
      (res.body.data as { id: string; depth: number; isActive: boolean }[]).map(
        (r) => [r.id, r]
      )
    );
    expect([...byId.keys()].sort()).toEqual([c, b, e, a].sort());
    expect(byId.get(a)?.depth).toBe(3);
    expect(byId.get(b)?.isActive).toBe(false);
  });

  it("a user with no reports gets an empty list", async () => {
    const lone = await user();
    const res = await reports(lone, "?transitive=true");
    expect(res.status).toBe(HTTP_STATUS.OK);
    expect(res.body).toEqual({ data: [], nextCursor: null });
  });

  it("unknown user is 404", async () => {
    const res = await reports(NON_EXISTENT_UUID);
    expect(res.status).toBe(HTTP_STATUS.NOT_FOUND);
  });

  it("transitive=maybe is 400 invalid_request", async () => {
    const res = await reports(await user(), "?transitive=maybe");
    expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(res.body.error).toBe("invalid_request");
  });

  it("a token carrying only groups.read is 403", async () => {
    const token = await getTestPrincipalToken({
      permissions: ["groups.read"],
    });
    const res = await reports(await user(), "", token);
    expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
  });
});
