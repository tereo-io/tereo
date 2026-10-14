const ADMIN_LEVEL = 5;

export const hasPermission = (
  userPermissions: string[],
  requiredPermission: string
): boolean => {
  if (userPermissions.includes("admin")) return true;
  if (userPermissions.includes(requiredPermission)) return true;

  for (const userPerm of userPermissions) {
    if (isAdminCovering(userPerm, requiredPermission)) return true;
    if (hasPermissionLevel(userPerm, requiredPermission)) return true;
  }

  return false;
};

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
