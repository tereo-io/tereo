import { type UserInfo, type ServiceKey } from "./config";
import { useMutation } from "@tanstack/react-query";
import type { AxiosInstance } from "axios";
import { useMemo } from "react";
import {
  signOut,
  useApi,
  usePublicApi,
  useAuth as useTereoAuth,
} from "@tereo-io/react";

export type { PermissionRequirement } from "@tereo-io/react";
export type { ServiceKey, UserInfo, UserOrganization } from "./config";
export { CoreAuthProvider } from "./provider";

export const useAuth = () => {
  const state = useTereoAuth<UserInfo>();
  const { user, isLive } = state;

  const organizations = useMemo(() => user?.organizations ?? [], [user]);
  const currentOrganization = useMemo(
    () => organizations.find((o) => String(o.id) === user?.org_id) ?? null,
    [organizations, user]
  );

  return useMemo(
    () => ({
      ...state,
      organizations,
      currentOrganization,
      isSocketConnected: isLive,
    }),
    [state, organizations, currentOrganization, isLive]
  );
};

/** The service's client, sending the user's access token. */
export const useAxios = (service: ServiceKey): AxiosInstance => useApi(service);

/** The service's client with no token, for cookies or open endpoints. */
export const usePublicAxios = (service: ServiceKey): AxiosInstance =>
  usePublicApi(service);

export const useLogout = () => useMutation({ mutationFn: () => signOut() });
