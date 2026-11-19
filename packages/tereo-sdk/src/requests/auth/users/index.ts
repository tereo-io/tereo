import { tryHandleRequest } from "../../../utils/tryHandleRequest.js";
import { CORE_CLIENT } from "../../../handler.js";
import { urlPath } from "../../paths.js";
import type {
  AuthServiceUser,
  ListUserReportsQuery,
  UserReportsResult,
  UserReportsTo,
} from "./types.js";

export * from "./types.js";

type Params = Record<string, string | number | boolean>;

const definedParams = (query: object): Params =>
  Object.fromEntries(
    Object.entries(query).filter(([, value]) => value !== undefined)
  ) as Params;

export const getUser = async (userId: string): Promise<AuthServiceUser> => {
  const res = await tryHandleRequest<AuthServiceUser>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.auth.getUser",
      method: "GET",
      url: urlPath`/v1/admin/users/${userId}`,
    },
    "AS_0001",
    `Failed to fetch user ${userId}`
  );
  return res.data;
};

/** Sends the user a link to confirm their email address. */
export const sendUserVerificationEmail = async (
  userId: string
): Promise<void> => {
  await tryHandleRequest(
    {
      clientName: CORE_CLIENT,
      requestName: "core.auth.sendVerificationEmail",
      method: "POST",
      url: urlPath`/v1/admin/users/${userId}/email-verification`,
    },
    "AS_0005",
    `Failed to send a verification email to user ${userId}`
  );
};

/**
 * The users among `userIds` (at most 100, all UUIDs) in one request. Ids
 * with no user are left out.
 */
export const getUsersByIds = async (
  userIds: string[]
): Promise<AuthServiceUser[]> => {
  const res = await tryHandleRequest<{ data: AuthServiceUser[] }>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.auth.getUsersByIds",
      method: "GET",
      url: "/v1/admin/users",
      params: {
        "filter[id]": userIds.join(","),
        "filter[id_op]": "in",
        limit: userIds.length,
      },
    },
    "AS_0003",
    `Failed to fetch ${userIds.length} users`
  );
  return res.data.data;
};

/** The users who report to this one, directly or at any depth. */
export const listUserReports = async (
  userId: string,
  query: ListUserReportsQuery = {}
): Promise<UserReportsResult> => {
  const res = await tryHandleRequest<UserReportsResult>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.auth.listUserReports",
      method: "GET",
      url: urlPath`/v1/admin/users/${userId}/reports`,
      params: definedParams(query),
    },
    "AS_0119",
    `Failed to list the reports of user ${userId}`
  );
  return res.data;
};

export const setUserReportsTo = async (
  userId: string,
  reportsToId: string
): Promise<UserReportsTo> => {
  const res = await tryHandleRequest<UserReportsTo>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.auth.setUserReportsTo",
      method: "PUT",
      url: urlPath`/v1/admin/users/${userId}/reports-to`,
      data: { userId: reportsToId },
    },
    "AS_0120",
    `Failed to set who user ${userId} reports to`
  );
  return res.data;
};

export const clearUserReportsTo = async (userId: string): Promise<void> => {
  await tryHandleRequest(
    {
      clientName: CORE_CLIENT,
      requestName: "core.auth.clearUserReportsTo",
      method: "DELETE",
      url: urlPath`/v1/admin/users/${userId}/reports-to`,
    },
    "AS_0121",
    `Failed to clear who user ${userId} reports to`
  );
};
