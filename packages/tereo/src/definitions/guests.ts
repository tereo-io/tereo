// The only core permissions a guest-assignable role may hold.
export const GUEST_CORE_PERMISSIONS: readonly string[] = [
  "file-service.objects.read",
  "file-service.objects.write",
];

export const isGuestAllowedCorePermission = (name: string): boolean =>
  GUEST_CORE_PERMISSIONS.includes(name);
