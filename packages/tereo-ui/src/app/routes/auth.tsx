import { type RouteObject } from "react-router-dom";
import { namedLazy, lazyPage } from "./lazy";

/**
 * Top-level public/unauthenticated routes outside the main layout.
 * Login, OAuth callback, 2FA, consent, and public share links.
 */
export const authRoutes: RouteObject[] = [
  {
    path: "/callback",
    element: namedLazy(
      () => import("@/features/auth/components/AuthCallback"),
      "AuthCallback"
    ),
  },
  {
    path: "/login",
    element: namedLazy(
      () => import("@/features/auth/components/login/LoginPage"),
      "LoginPage"
    ),
  },
  {
    path: "/login/org-select",
    element: namedLazy(
      () => import("@/features/auth/components/org-select/OrgSelectPage"),
      "OrgSelectPage"
    ),
  },
  {
    path: "/login/2fa",
    element: namedLazy(
      () => import("@/features/auth/components/totp/TotpChallengePage"),
      "TotpChallengePage"
    ),
  },
  {
    path: "/login/2fa/recovery",
    element: namedLazy(
      () => import("@/features/auth/components/totp/TotpRecoveryPage"),
      "TotpRecoveryPage"
    ),
  },
  {
    path: "/login/2fa/setup",
    element: namedLazy(
      () => import("@/features/auth/components/totp/TotpSetupPage"),
      "TotpSetupPage"
    ),
  },
  {
    path: "/login/link-required",
    element: namedLazy(
      () => import("@/features/auth/components/login/LinkRequiredPage"),
      "LinkRequiredPage"
    ),
  },
  {
    path: "/consent",
    element: namedLazy(
      () => import("@/features/auth/components/consent/ConsentPage"),
      "ConsentPage"
    ),
  },
  {
    path: "/logout",
    element: namedLazy(
      () => import("@/features/auth/components/logout/LogoutPage"),
      "LogoutPage"
    ),
  },
  {
    path: "/shared/:token",
    element: lazyPage(
      () => import("@/features/file-storage/components/shares/SharedPage")
    ),
  },
  {
    // Cosmetic filename suffix forwarded from the file download redirect — the
    // UI ignores the segment but needs it in the route table so react-router
    // doesn't 404. Only the :token is read by SharedPage.
    path: "/shared/:token/:filename",
    element: lazyPage(
      () => import("@/features/file-storage/components/shares/SharedPage")
    ),
  },
];
