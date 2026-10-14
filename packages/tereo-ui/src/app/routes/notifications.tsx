import { NotificationsSidebar } from "../layouts/NotificationsSidebar";
import { Navigate, type RouteObject } from "react-router-dom";
import { SectionLayout } from "../layouts/SectionLayout";
import { RequireAuth } from "@/features/auth";
import { namedLazy } from "./lazy";

export const notificationsRoute: RouteObject = {
  path: "notifications",
  element: (
    <SectionLayout title="Notifications" sidebar={<NotificationsSidebar />} />
  ),
  handle: { title: "Notifications" },
  children: [
    {
      index: true,
      element: <Navigate to="/notifications/log" replace />,
    },
    {
      path: "log",
      handle: { title: "Log" },
      element: (
        <RequireAuth requiredPermission="notifications.read">
          {namedLazy(
            () =>
              import("@/features/notifications/components/log/NotificationLog"),
            "NotificationLog"
          )}
        </RequireAuth>
      ),
    },
    {
      path: "connections",
      handle: { title: "Connections" },
      element: (
        <RequireAuth requiredPermission="notifications.read">
          {namedLazy(
            () =>
              import("@/features/notifications/components/connections/ConnectionList"),
            "ConnectionList"
          )}
        </RequireAuth>
      ),
    },
  ],
};
