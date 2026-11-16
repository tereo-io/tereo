/** One permission, or a list of which any one suffices. */
export type PermissionRequirement = string | readonly string[];

const ADMIN_LEVEL = 5;

const holdsPermission = (held: string[], required: string): boolean => {
  if (held.includes("admin")) return true;
  if (held.includes(required)) return true;

  for (const userPerm of held) {
    if (isAdminCovering(userPerm, required)) return true;
    if (hasPermissionLevel(userPerm, required)) return true;
  }

  return false;
};

export const hasPermission = (
  held: string[],
  required: PermissionRequirement
): boolean =>
  typeof required === "string"
    ? holdsPermission(held, required)
    : required.some((permission) => holdsPermission(held, permission));

const isAdminCovering = (
  userPermission: string,
  requiredPermission: string
): boolean => {
  const userLevel = getPermissionLevel(userPermission);
  if (userLevel !== ADMIN_LEVEL) return false;

  const userBase = getPermissionBase(userPermission);
  const requiredBase = getPermissionBase(requiredPermission);
  if (!userBase) return false;
  return requiredBase === userBase || requiredBase.startsWith(userBase + ".");
};

const getPermissionLevel = (permission: string): number => {
  const suffix = permission.split(".").pop();
  switch (suffix) {
    case "read":
      return 1;
    case "write":
      return 2;
    case "archive":
      return 3;
    case "delete":
      return 4;
    case "admin":
      return ADMIN_LEVEL;
    default:
      return 0;
  }
};

const hasPermissionLevel = (
  userPermission: string,
  requiredPermission: string
): boolean => {
  const userBase = getPermissionBase(userPermission);
  const requiredBase = getPermissionBase(requiredPermission);
  if (userBase !== requiredBase) return false;

  const userLevel = getPermissionLevel(userPermission);
  const requiredLevel = getPermissionLevel(requiredPermission);
  // Off-ladder permissions (`webhooks.emit`, `services.approve`) are implied by
  // nothing but themselves or an admin covering them.
  if (requiredLevel === 0) return false;
  return userLevel >= requiredLevel;
};

const getPermissionBase = (permission: string): string => {
  const parts = permission.split(".");
  if (parts.length <= 1) return "";
  return parts.slice(0, -1).join(".");
};
