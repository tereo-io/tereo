import { registerDeclaration } from "./registry.js";
import { logger } from "./logger.js";
import db from "./db/index.js";
import {
  CORE_DECLARATION,
  CORE_SERVICE,
  SYSTEM_USER,
} from "../definitions/index.js";

/**
 * Register core's own declaration, in-process, as the system user. Runs on
 * every start; unchanged since the last start, it is a no-op.
 */
export const registerCore = async () => {
  const result = await registerDeclaration(CORE_SERVICE, CORE_DECLARATION, {
    userId: SYSTEM_USER.id,
    email: null,
  });
  await reportInertOrgAssignments();
  return result;
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
