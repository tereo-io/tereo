import type { AxiosInstance } from "axios";
import { createContext } from "react";

/**
 * One key per area of core. Auth sits at core's root (`/oauth`, and
 * `/v1/account`, `/v1/admin` by path); the others under their own `/v1` prefix.
 */
export type ServiceKey = "auth" | "fileService" | "webhooks" | "audit";

export type ServiceConfig = Record<ServiceKey, string>;

export interface AxiosContextValue {
  instances: Record<ServiceKey, AxiosInstance>;
  baseInstances: Record<ServiceKey, AxiosInstance>;
}

export const AxiosContext = createContext<AxiosContextValue | null>(null);
