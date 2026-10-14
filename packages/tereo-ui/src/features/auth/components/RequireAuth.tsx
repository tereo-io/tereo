import { useAuth, type PermissionRequirement } from "@/lib/auth";
import { Navigate } from "react-router-dom";
import type { ReactNode } from "react";

interface RequireAuthProps {
  children: ReactNode;
  /** Any one of a list suffices. */
  requiredPermission?: PermissionRequirement;
}

export const RequireAuth = ({
  children,
  requiredPermission,
}: RequireAuthProps) => {
  const { hasPermission } = useAuth();

  if (requiredPermission && !hasPermission(requiredPermission)) {
    return <Navigate to="/account" replace />;
  }

  return <>{children}</>;
};
