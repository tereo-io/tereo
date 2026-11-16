import type { QueryClient } from "@tanstack/react-query";
import type { TereoAuthConfig } from "@tereo-io/react";
import env from "@/lib/env";

/**
 * One key per area of core. Auth sits at core's root (`/oauth`, and
 * `/v1/account`, `/v1/admin` by path); the others under their own `/v1` prefix.
 */
export type ServiceKey = "auth" | "fileService" | "webhooks" | "audit";

export interface UserOrganization {
  id: string;
  name: string;
  slug: string;
  memberRole: string;
}

// A type, not an interface, so it satisfies TereoUser's index signature.
export type UserInfo = {
  sub: string;
  email: string;
  name?: string;
  permissions: string[];
  org_id?: string;
  org_name?: string;
  organizations?: UserOrganization[];
};

// Route paths open to a signed-out visitor; "/" (signedOutPath) always is.
const isPublicPath = (path: string): boolean =>
  path.startsWith("/callback") ||
  path.startsWith("/setup") ||
  path.startsWith("/consent") ||
  path.startsWith("/login") ||
  path.startsWith("/logout") ||
  // Opened from an email by someone who is signed out.
  path === "/set-password" ||
  path === "/forgot-password" ||
  path === "/verify-email" ||
  // Public share-unlock page — recipients of a password-protected share link
  // are typically external users with no account.
  path.startsWith("/shared/");

export const createCoreAuthConfig = (
  queryClient: QueryClient
): TereoAuthConfig => {
  const apis: Record<ServiceKey, string> = {
    auth: env.CORE_URL,
    fileService: `${env.CORE_URL}/v1/files`,
    webhooks: `${env.CORE_URL}/v1/webhooks`,
    audit: `${env.CORE_URL}/v1/audit`,
  };

  return {
    coreUrl: env.CORE_URL,
    clientId: env.CLIENT_ID,
    redirectUri: env.REDIRECT_URI,
    apis,
    loadUser: async (clients) => {
      const { data } = await clients.auth.get<UserInfo>("/oauth/userinfo");
      return { ...data, permissions: data.permissions ?? [] };
    },
    basePath: env.BASE_PATH,
    signedOutPath: "/",
    isPublicPath,
    storagePrefix: "tereo",
    tokenExpirationBuffer: 60_000,
    onEvent: (event) => {
      if (event.type !== "session-revoked") return;
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      void queryClient.invalidateQueries({ queryKey: ["account", "sessions"] });
    },
  };
};
