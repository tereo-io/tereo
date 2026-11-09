import { beforeEach, describe, expect, it, vi } from "vitest";
import { CORE_CLIENT } from "../handler.js";
import {
  addGroupMembers,
  archiveGroup,
  createGroup,
  getGroup,
  listGroupMembers,
  listGroupRoles,
  listGroups,
  listUserGroups,
  removeGroupMember,
  restoreGroup,
  setGroupRoles,
  updateGroup,
} from "../requests/auth/groups/index.js";

const { tryHandleRequest } = vi.hoisted(() => ({ tryHandleRequest: vi.fn() }));
vi.mock("../utils/tryHandleRequest.js", () => ({ tryHandleRequest }));

beforeEach(() => {
  tryHandleRequest.mockReset();
  tryHandleRequest.mockResolvedValue({ data: { ok: true } });
});

const ID = "0190-a";
const USER = "0190-u";

const sent = () => tryHandleRequest.mock.calls[0];

describe("group requests", () => {
  it.each([
    [
      "listGroups",
      () => listGroups({ includeArchived: true, q: undefined }),
      "core.groups.list",
      "GET",
      "/v1/admin/groups",
      "AS_0107",
    ],
    [
      "getGroup",
      () => getGroup(ID),
      "core.groups.get",
      "GET",
      `/v1/admin/groups/${ID}`,
      "AS_0108",
    ],
    [
      "createGroup",
      () => createGroup({ slug: "s", name: "n" }),
      "core.groups.create",
      "POST",
      "/v1/admin/groups",
      "AS_0109",
    ],
    [
      "updateGroup",
      () => updateGroup(ID, { name: "n" }),
      "core.groups.update",
      "PATCH",
      `/v1/admin/groups/${ID}`,
      "AS_0110",
    ],
    [
      "archiveGroup",
      () => archiveGroup(ID),
      "core.groups.archive",
      "POST",
      `/v1/admin/groups/${ID}/archive`,
      "AS_0111",
    ],
    [
      "restoreGroup",
      () => restoreGroup(ID),
      "core.groups.restore",
      "POST",
      `/v1/admin/groups/${ID}/restore`,
      "AS_0112",
    ],
    [
      "listGroupMembers",
      () => listGroupMembers(ID, { limit: 5 }),
      "core.groups.listMembers",
      "GET",
      `/v1/admin/groups/${ID}/members`,
      "AS_0113",
    ],
    [
      "addGroupMembers",
      () => addGroupMembers(ID, [USER]),
      "core.groups.addMembers",
      "POST",
      `/v1/admin/groups/${ID}/members`,
      "AS_0114",
    ],
    [
      "removeGroupMember",
      () => removeGroupMember(ID, USER),
      "core.groups.removeMember",
      "DELETE",
      `/v1/admin/groups/${ID}/members/${USER}`,
      "AS_0115",
    ],
    [
      "listGroupRoles",
      () => listGroupRoles(ID),
      "core.groups.listRoles",
      "GET",
      `/v1/admin/groups/${ID}/roles`,
      "AS_0118",
    ],
    [
      "setGroupRoles",
      () => setGroupRoles(ID, ["r"]),
      "core.groups.setRoles",
      "PUT",
      `/v1/admin/groups/${ID}/roles`,
      "AS_0116",
    ],
    [
      "listUserGroups",
      () => listUserGroups(USER),
      "core.groups.listForUser",
      "GET",
      `/v1/admin/users/${USER}/groups`,
      "AS_0117",
    ],
  ])("%s", async (_name, call, requestName, method, url, code) => {
    await call();
    expect(sent()[0]).toMatchObject({
      clientName: CORE_CLIENT,
      requestName,
      method,
      url,
    });
    expect(sent()[1]).toBe(code);
  });

  it("sends only the query fields that are set", async () => {
    await listGroups({ includeArchived: true, q: undefined });
    expect(sent()[0].params).toEqual({ includeArchived: true });
  });

  it("passes includeArchived to the user's groups", async () => {
    await listUserGroups(USER, { includeArchived: true });
    expect(sent()[0].params).toEqual({ includeArchived: true });
    tryHandleRequest.mockClear();
    await listUserGroups(USER);
    expect(sent()[0].params).toEqual({});
  });

  it("sends bodies as given", async () => {
    await addGroupMembers(ID, [USER]);
    expect(sent()[0].data).toEqual({ userIds: [USER] });
    tryHandleRequest.mockClear();
    await setGroupRoles(ID, ["r"]);
    expect(sent()[0].data).toEqual({ roleIds: ["r"] });
  });

  it("escapes ids as path segments", async () => {
    await getGroup("a/b?c");
    expect(sent()[0].url).toBe("/v1/admin/groups/a%2Fb%3Fc");
  });
});
