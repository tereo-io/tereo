import type { Declaration, RegistrationResult } from "../../types/registry.js";
import { tryHandleRequest } from "../../utils/tryHandleRequest.js";
import { CORE_CLIENT } from "../../handler.js";

export const declare = async (
  declaration: Declaration
): Promise<RegistrationResult> => {
  const res = await tryHandleRequest<RegistrationResult>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.registry.declare",
      method: "POST",
      url: "/v1/registry/declaration",
      data: declaration,
    },
    "REG_0001",
    "Failed to register the service's declaration with core"
  );
  return res.data;
};
