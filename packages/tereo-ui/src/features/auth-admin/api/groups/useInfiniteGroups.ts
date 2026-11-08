import { useInfiniteCursor } from "@kosmeo-ui/react";
import { useAuth, useAxios } from "@/lib/auth";
import type { AxiosInstance } from "axios";
import type { Group } from "./types";
import { useMemo } from "react";

/**
 * Core's group list takes plain query params (`q`, `archived`,
 * `definitionSource`, `organizationId`), while InfiniteScroll emits every
 * menu option as `filter[<key>]`. Rewrites those, and pins the organization.
 */
const rewrite = (url: string, organizationId: string | undefined): string => {
  const [path, query = ""] = url.split("?");
  const params = new URLSearchParams();
  for (const [key, value] of new URLSearchParams(query)) {
    const filter = /^filter\[(.+)\]$/.exec(key);
    if (!filter) {
      // Group lists have a fixed order; core has no sort options.
      if (key !== "sort" && key !== "sortDir") params.append(key, value);
    } else if (!filter[1].endsWith("_op") && value !== "") {
      params.append(filter[1], value);
    }
  }
  if (organizationId) params.set("organizationId", organizationId);
  return `${path}?${params.toString()}`;
};

/**
 * Pass `organizationId` for one organization's groups (an organization
 * admin may read these without `groups.read`).
 */
const useInfiniteGroups = ({
  organizationId,
  enabled,
}: {
  organizationId?: string;
  enabled?: boolean;
} = {}) => {
  const { hasPermission } = useAuth();
  const axios = useAxios("auth");

  const scoped = useMemo(
    () =>
      new Proxy(axios, {
        get(target, prop, receiver) {
          if (prop === "get") {
            return (
              url: string,
              config?: Parameters<AxiosInstance["get"]>[1]
            ) => target.get(rewrite(url, organizationId), config);
          }
          return Reflect.get(target, prop, receiver);
        },
      }),
    [axios, organizationId]
  );

  return useInfiniteCursor<Group>({
    axiosInstance: scoped,
    endpoint: "/v1/admin/groups",
    queryKey: "groups",
    orgId: organizationId ?? null,
    enabled: enabled ?? (!!organizationId || hasPermission("groups.read")),
  });
};

export default useInfiniteGroups;
