export { resolveConfig, setActiveConfig, activeConfig } from "./config.js";
export type {
  ResolvedConfig,
  StorageKeys,
  TereoAuthConfig,
  TereoEvent,
  TereoUser,
} from "./config.js";
export { hasPermission } from "./permissions.js";
export type { PermissionRequirement } from "./permissions.js";
export {
  readJson,
  writeJson,
  removeKey,
  subscribeKey,
  useStoredValue,
} from "./storage.js";
