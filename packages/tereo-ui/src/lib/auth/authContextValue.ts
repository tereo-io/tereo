import type { UserInfo, UserOrganization } from "./useUserInfo";
import type { PermissionRequirement } from "./permissions";
import { createContext } from "react";

export interface AuthContextValue {
  user: UserInfo | null;
  isLoading: boolean;
  isSocketConnected: boolean;
  /** True if the user holds the permission, or any one of a list. */
  hasPermission: (required: PermissionRequirement) => boolean;
  currentOrganization: UserOrganization | null;
  organizations: UserOrganization[];
  switchOrganization: (orgId: string) => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | undefined>(
  undefined
);
