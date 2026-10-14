import { type RouteObject } from "react-router-dom";
import { namedLazy } from "./lazy";

export const setupRoute: RouteObject = {
  path: "/setup",
  element: namedLazy(
    () => import("@/features/setup/components/SetupPage"),
    "SetupPage"
  ),
};
