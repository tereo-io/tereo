import { loadProvisioningSet } from "./load.js";
import { applyProvisioning } from "./apply.js";
import { logger } from "../logger.js";
import env from "../../env.js";

export {
  applyProvisioning,
  deprovisionMissing,
  type ProvisioningResult,
} from "./apply.js";
export { ProvisioningError, loadProvisioningSet } from "./load.js";

export const provision = async (): Promise<void> => {
  const set = await loadProvisioningSet(env.PROVISIONING_PATH);
  if (!set) return;
  const result = await applyProvisioning(set);
  const changed = Object.values(result).some((entries) => entries.length > 0);
  logger.info(
    {
      documents: set.documents.map((d) => ({
        file: d.file,
        version: d.version,
        service: d.service?.slug ?? null,
        clients: d.clients.length,
        roles: d.roles.length,
      })),
      ...(changed && { ...result }),
    },
    changed ? "Applied the provisioning documents" : "Provisioning unchanged"
  );
};
