import { PERMISSION_CATALOG } from "./permissions.js";
import { CORE_VERSION } from "../utils/version.js";
import type { Declaration } from "./types.js";
import { EVENT_TYPES } from "./eventTypes.js";
import { BUCKETS } from "./buckets.js";
import { ROLES } from "./roles.js";

/** Core's own declaration, registered in-process on every start. */
export const CORE_DECLARATION: Declaration = {
  version: CORE_VERSION,
  permissions: PERMISSION_CATALOG,
  systemRoles: ROLES,
  buckets: BUCKETS,
  eventTypes: EVENT_TYPES,
};
