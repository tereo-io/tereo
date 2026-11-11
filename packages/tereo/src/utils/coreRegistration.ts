import { ensureDefaultOrganization } from "./defaultOrganization.js";
import { ensureCurrentPartitions } from "./partitions.js";
import { registerDeclaration } from "./registry.js";
import { resetCoreBuckets } from "./coreBuckets.js";
import { assertSystemUser } from "./users.js";
import { logger } from "./logger.js";
import db from "./db/index.js";
import {
  CORE_DECLARATION,
  CORE_SERVICE,
  SYSTEM_USER,
} from "../definitions/index.js";

/**
 * Register core's own declaration, in-process, as the system user. Runs on
 * every start; unchanged since the last start, it is a no-op. Core's buckets
 * are then put back to their declared settings, whether or not it changed.
 * `acceptOlder` is for the `register-core` CLI alone, after a rollback.
 */
export const registerCore = async (options: { acceptOlder?: boolean } = {}) => {
  const result = await registerDeclaration(
    CORE_SERVICE,
    CORE_DECLARATION,
    { userId: SYSTEM_USER.id, email: null },
    options
  );
  await resetCoreBuckets();
  await reportInertOrgAssignments();
  return result;
};

/**
 * What every process that registers core runs first — start, and the
 * provision CLI the chart's Job runs, possibly before any pod of the release
 * has started.
 */
export const prepareAndRegisterCore = async (
  options: { acceptOlder?: boolean } = {}
) => {
  // Webhook events need the default organization's id.
  await ensureDefaultOrganization();
  // The actor on system writes; every actor column references it.
  await assertSystemUser();
  // Registering core and provisioning write audit entries, which need
  // today's partition; the worker creates them a week ahead, but may be
  // down. A failure is logged and the caller goes on.
  await ensureCurrentPartitions().catch((err) => {
    logger.error({ err }, "Startup partition check failed");
  });
  // Core's own permissions, roles, buckets and event types.
  return registerCore(options);
};

/**
 * Roles assigned within an organization grant only org-assignable
 * permissions. Assignments made before that rule keep whatever else their
 * role carries, inert; an admin decides whether to replace them.
 */
const reportInertOrgAssignments = async () => {
  const count = await db.roles.countInertOrgAssignments();
  if (count > 0) {
    logger.warn(
      { count },
      "Org-scoped role assignments carry permissions that are not org-assignable; those permissions grant nothing there"
    );
  }
};
