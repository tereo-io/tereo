import fetchAllPages from "@/utils/fetchAllPages";
import { useQuery } from "@tanstack/react-query";
import type { Permission } from "./types";
import { useAxios } from "@/lib/auth";

/** Every active (unretired) permission — what a custom role can be given. */
const useAllPermissions = () => {
  const axios = useAxios("auth");

  return useQuery({
    queryKey: ["allPermissions"],
    queryFn: () =>
      fetchAllPages<Permission>(axios, "/v1/admin/permissions", {
        sort: "name",
        sortDir: "asc",
      }),
  });
};

export default useAllPermissions;
