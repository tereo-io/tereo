import useWebhooksOrganization from "../hooks/useWebhooksOrganization";
import type { AxiosInstance, AxiosRequestConfig } from "axios";
import { useAxios } from "@/lib/auth";
import { useMemo } from "react";

const HEADER = "X-Organization-ID";

const withOrganization = (
  orgId: string,
  config?: AxiosRequestConfig
): AxiosRequestConfig => ({
  ...config,
  headers: { ...(config?.headers as Record<string, string>), [HEADER]: orgId },
});

/**
 * The webhooks axios instance, sending `X-Organization-ID` when a
 * webhooks.admin has picked another organization. A proxy rather than a new
 * instance, which would lose the shared instance's auth interceptors; the
 * header stays off every other area's requests.
 */
const useWebhooksAxios = (): AxiosInstance => {
  const axios = useAxios("webhooks");
  const { overrideId } = useWebhooksOrganization();

  return useMemo(() => {
    if (!overrideId) return axios;
    return new Proxy(axios, {
      get(target, prop, receiver) {
        switch (prop) {
          case "request":
            return (config: AxiosRequestConfig) =>
              target.request(withOrganization(overrideId, config));
          case "get":
          case "delete":
          case "head":
          case "options":
            return (url: string, config?: AxiosRequestConfig) =>
              target[prop](url, withOrganization(overrideId, config));
          case "post":
          case "put":
          case "patch":
            return (url: string, data?: unknown, config?: AxiosRequestConfig) =>
              target[prop](url, data, withOrganization(overrideId, config));
          default:
            return Reflect.get(target, prop, receiver);
        }
      },
    });
  }, [axios, overrideId]);
};

export default useWebhooksAxios;
