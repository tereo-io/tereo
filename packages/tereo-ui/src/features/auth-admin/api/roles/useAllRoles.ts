import fetchAllPages from "@/utils/fetchAllPages";
import { useQuery } from "@tanstack/react-query";
import { useAxios } from "@/lib/auth";
import type { Role } from "./types";

/** Every unarchived, unretired role — the assignable set. */
const useAllRoles = () => {
  const axios = useAxios("auth");

  return useQuery({
    queryKey: ["allRoles"],
    queryFn: () =>
      fetchAllPages<Role>(axios, "/v1/admin/roles", {
        sort: "displayName",
        sortDir: "asc",
      }),
  });
};

export default useAllRoles;
