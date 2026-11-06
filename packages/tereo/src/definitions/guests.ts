import { PERMISSION_CATALOG } from "./permissions.js";

// The only core permissions a guest-assignable role may hold.
export const GUEST_CORE_PERMISSIONS: readonly string[] = [
  "file-service.objects.read",
  "file-service.objects.write",
];

const CORE_PERMISSION_NAMES = new Set(PERMISSION_CATALOG.map((p) => p.name));

export const isCorePermission = (name: string): boolean =>
  CORE_PERMISSION_NAMES.has(name);

export const isGuestAllowedCorePermission = (name: string): boolean =>
  GUEST_CORE_PERMISSIONS.includes(name);
