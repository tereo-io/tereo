import { tryHandleRequest } from "../../../utils/tryHandleRequest.js";
import { CORE_CLIENT } from "../../../handler.js";
import { AuthServiceUser } from "./types.js";
import { urlPath } from "../../paths.js";

export * from "./types.js";

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
