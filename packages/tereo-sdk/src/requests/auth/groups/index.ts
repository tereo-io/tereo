import { tryHandleRequest } from "../../../utils/tryHandleRequest.js";
import { CORE_CLIENT } from "../../../handler.js";
import { urlPath } from "../../paths.js";
import type {
  AddGroupMembersResult,
  CreateGroupBody,
  Group,
  GroupRolesResult,
  ListGroupMembersQuery,
  ListGroupsQuery,
  ListUserGroupsQuery,
  PaginatedGroupMembers,
  PaginatedGroups,
  SetGroupRolesResult,
  UpdateGroupBody,
  UserGroupsResult,
} from "./types.js";

export * from "./types.js";

type Params = Record<string, string | number | boolean>;

const definedParams = (query: object): Params =>
  Object.fromEntries(
    Object.entries(query).filter(([, value]) => value !== undefined)
  ) as Params;

export const listGroups = async (
  query: ListGroupsQuery = {}
): Promise<PaginatedGroups> => {
  const res = await tryHandleRequest<PaginatedGroups>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.groups.list",
      method: "GET",
      url: "/v1/admin/groups",
      params: definedParams(query),
    },
    "AS_0107",
    "Failed to list groups"
  );
  return res.data;
};

export const getGroup = async (id: string): Promise<Group> => {
  const res = await tryHandleRequest<Group>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.groups.get",
      method: "GET",
      url: urlPath`/v1/admin/groups/${id}`,
    },
    "AS_0108",
    `Failed to fetch group ${id}`
  );
  return res.data;
};

export const createGroup = async (body: CreateGroupBody): Promise<Group> => {
  const res = await tryHandleRequest<Group>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.groups.create",
      method: "POST",
      url: "/v1/admin/groups",
      data: body,
    },
    "AS_0109",
    "Failed to create group"
  );
  return res.data;
};

export const updateGroup = async (
  id: string,
  body: UpdateGroupBody
): Promise<Group> => {
  const res = await tryHandleRequest<Group>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.groups.update",
      method: "PATCH",
      url: urlPath`/v1/admin/groups/${id}`,
      data: body,
    },
    "AS_0110",
    `Failed to update group ${id}`
  );
  return res.data;
};

export const archiveGroup = async (id: string): Promise<Group> => {
  const res = await tryHandleRequest<Group>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.groups.archive",
      method: "POST",
      url: urlPath`/v1/admin/groups/${id}/archive`,
    },
    "AS_0111",
    `Failed to archive group ${id}`
  );
  return res.data;
};

export const restoreGroup = async (id: string): Promise<Group> => {
  const res = await tryHandleRequest<Group>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.groups.restore",
      method: "POST",
      url: urlPath`/v1/admin/groups/${id}/restore`,
    },
    "AS_0112",
    `Failed to restore group ${id}`
  );
  return res.data;
};

export const listGroupMembers = async (
  id: string,
  query: ListGroupMembersQuery = {}
): Promise<PaginatedGroupMembers> => {
  const res = await tryHandleRequest<PaginatedGroupMembers>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.groups.listMembers",
      method: "GET",
      url: urlPath`/v1/admin/groups/${id}/members`,
      params: definedParams(query),
    },
    "AS_0113",
    `Failed to list members of group ${id}`
  );
  return res.data;
};

/** At most 500 user ids per call. */
export const addGroupMembers = async (
  id: string,
  userIds: string[]
): Promise<AddGroupMembersResult> => {
  const res = await tryHandleRequest<AddGroupMembersResult>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.groups.addMembers",
      method: "POST",
      url: urlPath`/v1/admin/groups/${id}/members`,
      data: { userIds },
    },
    "AS_0114",
    `Failed to add members to group ${id}`
  );
  return res.data;
};

export const removeGroupMember = async (
  id: string,
  userId: string
): Promise<void> => {
  await tryHandleRequest<void>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.groups.removeMember",
      method: "DELETE",
      url: urlPath`/v1/admin/groups/${id}/members/${userId}`,
    },
    "AS_0115",
    `Failed to remove user ${userId} from group ${id}`
  );
};

/** Every role the group holds, archived, inactive or retired ones included. */
export const listGroupRoles = async (id: string): Promise<GroupRolesResult> => {
  const res = await tryHandleRequest<GroupRolesResult>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.groups.listRoles",
      method: "GET",
      url: urlPath`/v1/admin/groups/${id}/roles`,
    },
    "AS_0118",
    `Failed to list the roles of group ${id}`
  );
  return res.data;
};

/** Replaces the group's roles with `roleIds` (at most 100). */
export const setGroupRoles = async (
  id: string,
  roleIds: string[]
): Promise<SetGroupRolesResult> => {
  const res = await tryHandleRequest<SetGroupRolesResult>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.groups.setRoles",
      method: "PUT",
      url: urlPath`/v1/admin/groups/${id}/roles`,
      data: { roleIds },
    },
    "AS_0116",
    `Failed to set the roles of group ${id}`
  );
  return res.data;
};

export const listUserGroups = async (
  userId: string,
  query: ListUserGroupsQuery = {}
): Promise<UserGroupsResult> => {
  const res = await tryHandleRequest<UserGroupsResult>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.groups.listForUser",
      method: "GET",
      url: urlPath`/v1/admin/users/${userId}/groups`,
      params: definedParams(query),
    },
    "AS_0117",
    `Failed to list the groups of user ${userId}`
  );
  return res.data;
};
