import { tryHandleRequest } from "../../../utils/tryHandleRequest.js";
import { AuthServiceOwnService } from "./types.js";
import { CORE_CLIENT } from "../../../handler.js";

export * from "./types.js";

/** The service whose client is calling. 404 for any other caller. */
export const getOwnService = async (): Promise<AuthServiceOwnService> => {
  const res = await tryHandleRequest<AuthServiceOwnService>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.auth.getOwnService",
      method: "GET",
      url: "/v1/account/service",
    },
    "AS_0004",
    "Failed to fetch this service from core"
  );
  return res.data;
};
