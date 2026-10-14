import type { AxiosInstance } from "axios";
import { useAxios } from "@/lib/auth";
import { useMemo } from "react";

const liftFlags = (url: string, flags: readonly string[]): string => {
  const [path, query = ""] = url.split("?");
  const params = new URLSearchParams(query);
  for (const flag of flags) {
    const value = params.get(`filter[${flag}]`);
    params.delete(`filter[${flag}]`);
    params.delete(`filter[${flag}_op]`);
    if (value === "true") params.set(flag, "true");
  }
  const rest = params.toString();
  return rest ? `${path}?${rest}` : path;
};

/**
 * The core auth axios instance, with list-menu flags lifted out of the
 * `filter[...]` bag. InfiniteScroll emits every menu option as
 * `filter[<key>]`, but core reads flags such as `includeRetired` as top-level
 * query params and rejects unknown filter fields with a 400.
 * (`useInfiniteArchivableCursor` already does this for `includeArchived`.)
 */
const useFlagLiftingAxios = (...flags: string[]): AxiosInstance => {
  const axios = useAxios("auth");
  const key = flags.join(",");

  return useMemo(() => {
    const lifted = key.split(",");
    return new Proxy(axios, {
      get(target, prop, receiver) {
        if (prop === "get") {
          return (url: string, config?: Parameters<AxiosInstance["get"]>[1]) =>
            target.get(liftFlags(url, lifted), config);
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }, [axios, key]);
};

export default useFlagLiftingAxios;
