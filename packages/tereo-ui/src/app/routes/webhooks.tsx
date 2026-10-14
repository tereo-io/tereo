import { Navigate, type RouteObject } from "react-router-dom";
import { WebhooksSidebar } from "../layouts/WebhooksSidebar";
import { SectionLayout } from "../layouts/SectionLayout";
import { RequireAuth } from "@/features/auth";
import { namedLazy } from "./lazy";

const requires = (permission: string, element: React.ReactNode) => (
  <RequireAuth requiredPermission={permission}>{element}</RequireAuth>
);

export const webhooksRoute: RouteObject = {
  path: "webhooks",
  element: <SectionLayout title="Webhooks" sidebar={<WebhooksSidebar />} />,
  handle: { title: "Webhooks" },
  children: [
    {
      index: true,
      element: <Navigate to="/webhooks/endpoints" replace />,
    },
    {
      element: namedLazy(
        () =>
          import("@/features/webhooks/components/organization/WebhooksOrganizationLayout"),
        "WebhooksOrganizationLayout"
      ),
      children: [
        {
          path: "endpoints",
          handle: { title: "Webhook Endpoints" },
          element: requires(
            "webhooks.read",
            namedLazy(
              () =>
                import("@/features/webhooks/components/endpoints/WebhookEndpointList"),
              "WebhookEndpointList"
            )
          ),
        },
        {
          path: "endpoints/:endpointId",
          element: requires(
            "webhooks.read",
            namedLazy(
              () =>
                import("@/features/webhooks/components/endpoints/WebhookEndpointDetail"),
              "WebhookEndpointDetail"
            )
          ),
        },
      ],
    },
    {
      path: "event-types",
      handle: { title: "Event Types" },
      element: requires(
        "webhooks.event-types.read",
        namedLazy(
          () =>
            import("@/features/webhooks/components/event-types/EventTypeList"),
          "EventTypeList"
        )
      ),
    },
  ],
};
