// @module-tag int
// @module-tag auth
import { ensureDefaultOrganization } from "../../utils/defaultOrganization.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { connect, received, type TestSocket } from "../support/socket.js";
import { getTestPrincipalToken } from "../support/principals.js";
import { HTTP_STATUS } from "../support/auth/constants.js";
import { randomUUID } from "node:crypto";
import {
  adminApi,
  deleteGroups,
  ensureGroupPermission,
  GROUP_PERMISSION,
  postGroup,
  roleGranting,
} from "../support/groups.js";

const PERMISSIONS_CHANGED = "auth:permissions:changed";

const groupIds: string[] = [];
let admin: string;

beforeAll(async () => {
  await ensureDefaultOrganization();
  await ensureGroupPermission();
  admin = await getTestPrincipalToken({
    permissions: ["groups.admin", GROUP_PERMISSION],
  });
});

afterAll(async () => {
  await deleteGroups(groupIds);
});

/** Runs `change` and expects `socket` to be told its permissions changed. */
const toldOf = async (
  socket: TestSocket,
  change: () => Promise<{ status: number }>,
  status: number
) => {
  socket.events.length = 0;
  expect((await change()).status).toBe(status);
  await received(socket, PERMISSIONS_CHANGED);
  expect(socket.events.find((e) => e.name === PERMISSIONS_CHANGED)).toEqual({
    name: PERMISSIONS_CHANGED,
    payload: expect.objectContaining({ reason: "user_roles_changed" }),
  });
};

describe("group changes reach members' sockets", () => {
  it("adding, setting roles, archiving, restoring and removing each tell the member", async () => {
    const role = await roleGranting();
    const group = await postGroup(admin, { roleIds: [role.id] });
    groupIds.push(group.id);
    const userId = randomUUID();
    const socket = connect(
      await getTestPrincipalToken({ userId, permissions: [] })
    );
    try {
      expect(await socket.connected).toBeNull();
      const path = `/groups/${group.id}`;

      await toldOf(
        socket,
        () => adminApi("POST", `${path}/members`, admin, { userIds: [userId] }),
        HTTP_STATUS.OK
      );
      await toldOf(
        socket,
        () => adminApi("PUT", `${path}/roles`, admin, { roleIds: [] }),
        HTTP_STATUS.OK
      );
      await toldOf(
        socket,
        () => adminApi("POST", `${path}/archive`, admin),
        HTTP_STATUS.OK
      );
      await toldOf(
        socket,
        () => adminApi("POST", `${path}/restore`, admin),
        HTTP_STATUS.OK
      );
      await toldOf(
        socket,
        () => adminApi("DELETE", `${path}/members/${userId}`, admin),
        HTTP_STATUS.NO_CONTENT
      );
    } finally {
      socket.close();
    }
  });
});
