import { applyProvisioning, type ProvisioningResult } from "./apply.js";
import { loadProvisioningSet } from "./load.js";
import { logger } from "../logger.js";
import env from "../../env.js";

export {
  applyProvisioning,
  deprovisionMissing,
  type ProvisioningResult,
} from "./apply.js";
export { ProvisioningError, loadProvisioningSet } from "./load.js";

export const provision = async (
  options: { path?: string; dryRun?: boolean } = {}
): Promise<ProvisioningResult | null> => {
  const set = await loadProvisioningSet(options.path ?? env.PROVISIONING_PATH);
  if (!set) return null;
  const result = await applyProvisioning(set, new Date(), {
    dryRun: options.dryRun,
  });
  if (options.dryRun) return result;
  const changed = Object.values(result).some((entries) => entries.length > 0);
  logger.info(
    {
      documents: set.documents.map((d) => ({
        file: d.file,
        version: d.version,
        service: d.service?.slug ?? null,
        clients: d.clients.length,
        roles: d.roles.length,
        integrations: d.integrations?.length ?? 0,
      })),
      ...(changed && { ...result }),
    },
    changed ? "Applied the provisioning documents" : "Provisioning unchanged"
  );
  return result;
};
