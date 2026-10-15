import { applyProvisioning } from "./apply.js";
import { loadProvisioning } from "./load.js";
import { logger } from "../logger.js";
import env from "../../env.js";

export {
  applyProvisioning,
  deprovisionMissing,
  type ProvisioningResult,
} from "./apply.js";
export { ProvisioningError, loadProvisioning } from "./load.js";

/** Apply `PROVISIONING_FILE`, if set. A file that cannot be applied throws. */
export const provision = async (): Promise<void> => {
  const provisioning = await loadProvisioning(env.PROVISIONING_FILE);
  if (!provisioning) return;
  const result = await applyProvisioning(provisioning);
  const changed = Object.values(result).some((entries) => entries.length > 0);
  logger.info(
    {
      services: provisioning.services.length,
      clients: provisioning.clients.length,
      ...(changed && { ...result }),
    },
    changed ? "Applied the provisioning file" : "Provisioning file unchanged"
  );
};
