import { tryHandleRequest } from "../../../utils/tryHandleRequest.js";
import { AuthServiceOrganization } from "./types.js";
import { CORE_CLIENT } from "../../../handler.js";
import { urlPath } from "../../paths.js";

export * from "./types.js";

export const getOrganizationById = async (
  id: string
): Promise<AuthServiceOrganization> => {
  const res = await tryHandleRequest<AuthServiceOrganization>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.auth.getOrganization",
      method: "GET",
      url: urlPath`/v1/admin/organizations/${id}`,
    },
    "AS_0002",
    `Failed to fetch organization ${id}`
  );
  return res.data;
};
