import { Navigate, type RouteObject } from "react-router-dom";
import { ServicesSidebar } from "../layouts/ServicesSidebar";
import { SectionLayout } from "../layouts/SectionLayout";
import { RequireAuth } from "@/features/auth";
import { namedLazy } from "./lazy";

const canRead = (element: React.ReactNode) => (
  <RequireAuth requiredPermission="services.read">{element}</RequireAuth>
);

export const servicesRoute: RouteObject = {
  path: "services",
  element: <SectionLayout title="Services" sidebar={<ServicesSidebar />} />,
  handle: { title: "Services" },
  children: [
    {
      index: true,
      element: <Navigate to="/services/list" replace />,
    },
    {
      path: "list",
      element: canRead(
        namedLazy(
          () => import("@/features/services/components/ServiceList"),
          "ServiceList"
        )
      ),
    },
    {
      path: ":serviceId",
      element: canRead(
        namedLazy(
          () => import("@/features/services/components/ServiceDetail"),
          "ServiceDetail"
        )
      ),
    },
  ],
};
