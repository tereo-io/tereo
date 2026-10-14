import { Navigate, Outlet } from "react-router-dom";
import useSetupStatus from "../api/useSetupStatus";
import { LoadingOverlay } from "@kosmeo-ui/react";

/**
 * Sends every route under it to `/setup` while core has no admin, so a fresh
 * instance opens on the setup screen rather than a login that cannot succeed.
 * If the status cannot be fetched the routes render as usual and surface the
 * failure themselves.
 */
export const SetupGate = () => {
  const { data, isLoading } = useSetupStatus();

  if (isLoading) return <LoadingOverlay show message="Loading..." />;
  if (data && !data.setupComplete) return <Navigate to="/setup" replace />;
  return <Outlet />;
};
