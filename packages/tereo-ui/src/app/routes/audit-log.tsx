import { Navigate, type RouteObject } from "react-router-dom";
import { AuditLogSidebar } from "../layouts/AuditLogSidebar";
import { SectionLayout } from "../layouts/SectionLayout";
import { RequireAuth } from "@/features/auth";
import { namedLazy } from "./lazy";

const canRead = (element: React.ReactNode) => (
  <RequireAuth requiredPermission="audit-logs.read">{element}</RequireAuth>
);

export const auditLogRoute: RouteObject = {
  path: "audit-log",
  element: <SectionLayout title="Audit Log" sidebar={<AuditLogSidebar />} />,
  handle: { title: "Audit Log" },
  children: [
    {
      index: true,
      element: <Navigate to="/audit-log/entries" replace />,
    },
    {
      path: "entries",
      handle: { title: "Entries" },
      element: canRead(
        namedLazy(
          () => import("@/features/audit-log/components/AuditLogList"),
          "AuditLogList"
        )
      ),
    },
    {
      path: "entity/:entityType/:entityId",
      handle: { title: "Entity History" },
      element: canRead(
        namedLazy(
          () => import("@/features/audit-log/components/EntityHistory"),
          "EntityHistory"
        )
      ),
    },
  ],
};
