import { ErrorPage } from "./ErrorPage";
import {
  isRouteErrorResponse,
  useNavigate,
  useRouteError,
} from "react-router-dom";

export const RouteErrorBoundary = () => {
  const routeError = useRouteError();
  const navigate = useNavigate();

  let error: Error;
  if (isRouteErrorResponse(routeError)) {
    error = new Error(
      `${routeError.status} ${routeError.statusText}${
        routeError.data ? ` — ${String(routeError.data)}` : ""
      }`
    );
  } else if (routeError instanceof Error) {
    error = routeError;
  } else {
    error = new Error(
      typeof routeError === "string" ? routeError : "Unknown route error"
    );
  }

  console.error("[RouteErrorBoundary]", routeError);

  return <ErrorPage error={error} onReset={() => navigate(0)} />;
};
