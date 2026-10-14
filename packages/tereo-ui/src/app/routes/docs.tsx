import { faBook } from "@fortawesome/free-solid-svg-icons";
import { type RouteObject } from "react-router-dom";
import { namedLazy } from "./lazy";

// One spec at full width: no SectionLayout, so no section sidebar. Redoc's own
// operations menu does the navigating. Like `/account`, it's outside SECTIONS
// because it needs no permission.
export const docsRoute: RouteObject = {
  path: "docs",
  handle: { title: "API Docs" },
  element: (
    <main className="t-main">
      {namedLazy(
        () => import("@/features/api-docs/components/ApiDocsPage"),
        "ApiDocsPage"
      )}
    </main>
  ),
};

export const docsNav = {
  to: "/docs",
  label: "API Docs",
  icon: faBook,
};
