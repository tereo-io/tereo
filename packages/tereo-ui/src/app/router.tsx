import { RouteErrorBoundary } from "@/components/ErrorBoundary";
import { LoadingOverlay } from "@kosmeo-ui/react";
import { RootLayout } from "./layouts/RootLayout";
import { accountRoute } from "./routes/account";
import { SetupGate } from "@/features/setup";
import { setupRoute } from "./routes/setup";
import { authRoutes } from "./routes/auth";
import { docsRoute } from "./routes/docs";
import { SECTIONS } from "./sections";
import { useAuth } from "@/lib/auth";
import env from "@/lib/env";
import {
  createBrowserRouter,
  Navigate,
  RouterProvider,
} from "react-router-dom";

/**
 * The landing page is the first section the user can see. Sections whose
 * permission they lack still mount, so a deep link explains itself instead of
 * bouncing; the top bar hides them.
 */
const DefaultSection = () => {
  const { hasPermission } = useAuth();
  const section = SECTIONS.find((s) => hasPermission(s.nav.permission));
  return <Navigate to={section?.nav.to ?? "/account"} replace />;
};

const router = createBrowserRouter(
  [
    setupRoute,
    {
      // Until core has its first admin, everything else leads to /setup.
      element: <SetupGate />,
      children: [
        {
          path: "/",
          element: <RootLayout />,
          errorElement: <RouteErrorBoundary />,
          children: [
            { index: true, element: <DefaultSection /> },
            ...SECTIONS.map((s) => s.route),
            accountRoute,
            docsRoute,
            { path: "*", element: <DefaultSection /> },
          ],
        },
        ...authRoutes,
      ],
    },
  ],
  { basename: env.BASE_PATH || "/" }
);

export const AppRouter = () => {
  const { isLoading } = useAuth();

  return (
    <>
      <RouterProvider router={router} />
      <LoadingOverlay show={isLoading} message="Loading..." />
    </>
  );
};
