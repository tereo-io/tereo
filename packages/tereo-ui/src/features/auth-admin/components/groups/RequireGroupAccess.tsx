import { useGroupAccess } from "./useGroupAuthority";
import { Navigate } from "react-router-dom";
import type { ReactNode } from "react";

/**
 * Guards a group's page: `groups.read`, or authority over some
 * organization's groups. GroupDetail shows what the group itself allows.
 */
export const RequireGroupAccess = ({ children }: { children: ReactNode }) => {
  const { canReadAny } = useGroupAccess();
  if (!canReadAny) return <Navigate to="/account" replace />;
  return <>{children}</>;
};
