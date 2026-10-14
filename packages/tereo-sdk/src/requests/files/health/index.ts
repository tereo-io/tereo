import { tryHandleRequest } from "../../../utils/tryHandleRequest.js";
import { RequestError } from "../../../utils/errors.js";
import { CORE_CLIENT } from "../../../handler.js";
import { FileServiceHealth } from "./types.js";

export * from "./types.js";

const CODE = "FS_0030";
const MESSAGE = "Failed to fetch core health";

/**
 * Core's health, `degraded` included: core answers that with 503, which is
 * accepted here rather than retried and thrown. A 503 without a health body
 * (a proxy's, say) still throws.
 */
export const getHealth = async (): Promise<FileServiceHealth> => {
  const res = await tryHandleRequest<FileServiceHealth>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.health",
      method: "GET",
      url: `/health`,
      validateStatus: (status) =>
        (status >= 200 && status < 300) || status === 503,
    },
    CODE,
    MESSAGE
  );
  if (res.status === 503 && res.data?.status !== "degraded") {
    throw new RequestError(CODE, MESSAGE, {
      metadata: {
        client: CORE_CLIENT,
        originalError: { status: 503, data: res.data },
      },
    });
  }
  return res.data;
};
