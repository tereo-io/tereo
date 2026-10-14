import type { UserListItem } from "@/features/auth-admin/types/user";
import { useQuery } from "@tanstack/react-query";
import { useAxios } from "@/lib/auth";

const useInitialUsers = (enabled: boolean) => {
  const axios = useAxios("auth");
  return useQuery({
    queryKey: ["user-search-initial", 50],
    enabled,
    queryFn: async (): Promise<UserListItem[]> => {
      const res = await axios.get(`/v1/admin/users`, {
        params: {
          "filter[isActive]": "true",
          limit: 50,
          sort: "email",
          sortDir: "asc",
        },
      });
      return res.data.data;
    },
  });
};

export default useInitialUsers;
