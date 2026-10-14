import { type RouteObject } from "react-router-dom";
import { namedLazy } from "./lazy";

// `/account` is a standalone, top-level page that lives outside the section
// layouts so it doesn't pick up a sidebar.
export const accountRoute: RouteObject = {
  path: "account",
  handle: { title: "My Account" },
  element: (
    <main className="t-main">
      {namedLazy(
        () => import("@/features/auth-admin/components/account/MyAccountPage"),
        "MyAccountPage"
      )}
    </main>
  ),
};
