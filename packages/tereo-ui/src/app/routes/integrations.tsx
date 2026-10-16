import { IntegrationsSidebar } from "../layouts/IntegrationsSidebar";
import { Navigate, type RouteObject } from "react-router-dom";
import { SectionLayout } from "../layouts/SectionLayout";
import { RequireAuth } from "@/features/auth";
import { namedLazy } from "./lazy";

const canRead = (element: React.ReactNode) => (
  <RequireAuth requiredPermission="integrations.read">{element}</RequireAuth>
);

export const integrationsRoute: RouteObject = {
  path: "integrations",
  element: (
    <SectionLayout title="Integrations" sidebar={<IntegrationsSidebar />} />
  ),
  handle: { title: "Integrations" },
  children: [
    {
      index: true,
      element: <Navigate to="/integrations/list" replace />,
    },
    {
      path: "list",
      element: canRead(
        namedLazy(
          () => import("@/features/integrations/components/IntegrationList"),
          "IntegrationList"
        )
      ),
    },
    {
      path: ":integrationId",
      element: canRead(
        namedLazy(
          () => import("@/features/integrations/components/IntegrationDetail"),
          "IntegrationDetail"
        )
      ),
    },
  ],
};
