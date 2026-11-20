// @module-tag int
// @module-tag auth
import { createAppServiceAccount } from "../../../../../../support/testService.js";
import { getTestPrincipalToken } from "../../../../../../support/principals.js";
import { SYSTEM_USER_ID } from "../../../../../../../definitions/index.js";
import { createScimConnection } from "../../../../../../support/scim.js";
import { createTestUser } from "../../../../../../support/auth/users.js";
import { createGuest } from "../../../../../../support/passwordSetup.js";
import { manage, tag } from "../../../../../../support/scimUsers.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import { adminApi } from "../../../../../../support/groups.js";
import {
  HTTP_STATUS,
  NON_EXISTENT_UUID,
} from "../../../../../../support/auth/constants.js";

const userIds: string[] = [];
let writer: string;

const user = async (opts: { isActive?: boolean } = {}) => {
  const created = await createTestUser(opts);
  userIds.push(created.id);
  return created.id;
};

const put = (id: string, userId: string, token = writer) =>
  adminApi("PUT", `/users/${id}/reports-to`, token, { userId });
const del = (id: string, token = writer) =>
  adminApi("DELETE", `/users/${id}/reports-to`, token);
const reportsToIdOf = async (id: string) =>
  (await prisma.user.findUniqueOrThrow({ where: { id } })).reportsToId;

beforeAll(async () => {
  writer = await getTestPrincipalToken({
    permissions: ["users.reports.write"],
  });
});

afterAll(async () => {
  await prisma.user.updateMany({
    where: { id: { in: userIds } },
    data: { reportsToId: null },
  });
});

describe("/v1/admin/users/:id/reports-to", () => {
  it("sets and returns reportsTo", async () => {
    const [a, b] = [await user(), await user()];
    const res = await put(a, b);
    expect(res.status).toBe(HTTP_STATUS.OK);
    expect(res.body.userId).toBe(a);
    expect(res.body.reportsTo).toMatchObject({ id: b, isActive: true });
    expect(Object.keys(res.body.reportsTo).sort()).toEqual([
      "email",
      "id",
      "isActive",
      "name",
    ]);
    expect(await reportsToIdOf(a)).toBe(b);
  });

  it("changes it", async () => {
    const [a, b, c] = [await user(), await user(), await user()];
    expect((await put(a, b)).status).toBe(HTTP_STATUS.OK);
    const res = await put(a, c);
    expect(res.status).toBe(HTTP_STATUS.OK);
    expect(res.body.reportsTo.id).toBe(c);
    expect(await reportsToIdOf(a)).toBe(c);
  });

  it("DELETE clears it", async () => {
    const [a, b] = [await user(), await user()];
    await put(a, b);
    const res = await del(a);
    expect(res.status).toBe(HTTP_STATUS.NO_CONTENT);
    expect(await reportsToIdOf(a)).toBeNull();
  });

  it("DELETE with none set is 204", async () => {
    const a = await user();
    expect((await del(a)).status).toBe(HTTP_STATUS.NO_CONTENT);
  });

  it("refuses reporting to oneself", async () => {
    const a = await user();
    const res = await put(a, a);
    expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(res.body.error).toBe("reports_to_cycle");
  });

  it("refuses a loop through others", async () => {
    const [a, b, c] = [await user(), await user(), await user()];
    expect((await put(b, c)).status).toBe(HTTP_STATUS.OK);
    expect((await put(c, a)).status).toBe(HTTP_STATUS.OK);
    for (const manager of [b, c]) {
      const res = await put(a, manager);
      expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(res.body.error).toBe("reports_to_cycle");
    }
    expect(await reportsToIdOf(a)).toBeNull();
  });

  it("refuses a service account on either side", async () => {
    const a = await user();
    const { userId: service } = await createAppServiceAccount("reports-to");
    const asSubject = await put(service, a);
    expect(asSubject.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(asSubject.body.error).toBe("reports_to_not_allowed");
    const asManager = await put(a, service);
    expect(asManager.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(asManager.body.error).toBe("reports_to_not_allowed");
  });

  it("refuses the system user on either side", async () => {
    const a = await user();
    const asSubject = await put(SYSTEM_USER_ID, a);
    expect(asSubject.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(asSubject.body.error).toBe("system_user");
    const asManager = await put(a, SYSTEM_USER_ID);
    expect(asManager.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(asManager.body.error).toBe("reports_to_not_allowed");
  });

  it("refuses a guest as manager, allows a guest as report", async () => {
    const a = await user();
    const guest = (await createGuest()).id;
    userIds.push(guest);
    const asManager = await put(a, guest);
    expect(asManager.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(asManager.body.error).toBe("reports_to_not_allowed");
    const asReport = await put(guest, a);
    expect(asReport.status).toBe(HTTP_STATUS.OK);
    expect(await reportsToIdOf(guest)).toBe(a);
  });

  it("accepts deactivated users on either side", async () => {
    const [a, b] = [
      await user({ isActive: false }),
      await user({ isActive: false }),
    ];
    const res = await put(a, b);
    expect(res.status).toBe(HTTP_STATUS.OK);
    expect(res.body.reportsTo).toMatchObject({ id: b, isActive: false });
  });

  it("unknown manager is 400 unknown_user", async () => {
    const a = await user();
    const res = await put(a, NON_EXISTENT_UUID);
    expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(res.body.error).toBe("unknown_user");
  });

  it("unknown subject is 404", async () => {
    const a = await user();
    expect((await put(NON_EXISTENT_UUID, a)).status).toBe(
      HTTP_STATUS.NOT_FOUND
    );
    expect((await del(NON_EXISTENT_UUID)).status).toBe(HTTP_STATUS.NOT_FOUND);
  });

  it("allows a SCIM-managed user", async () => {
    const c = await createScimConnection();
    const managed = await createTestUser({ email: `m-${tag()}@${c.domain}` });
    userIds.push(managed.id);
    await manage(c.connectionId, managed.id, managed.email);
    const b = await user();
    expect((await put(managed.id, b)).status).toBe(HTTP_STATUS.OK);
    expect(await reportsToIdOf(managed.id)).toBe(b);
  });

  it("users.write alone is 403", async () => {
    const [a, b] = [await user(), await user()];
    const usersWriter = await getTestPrincipalToken({
      permissions: ["users.write"],
    });
    expect((await put(a, b, usersWriter)).status).toBe(HTTP_STATUS.FORBIDDEN);
    expect((await del(a, usersWriter)).status).toBe(HTTP_STATUS.FORBIDDEN);
  });

  it("returns 400 invalid_request for a userId that is not a UUID", async () => {
    const a = await user();
    const res = await adminApi("PUT", `/users/${a}/reports-to`, writer, {
      userId: "x",
    });
    expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(res.body.error).toBe("invalid_request");
    expect(res.body.error_description).toMatch(/^Invalid request body\. /);
  });
});
