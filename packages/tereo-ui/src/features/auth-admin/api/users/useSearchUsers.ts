import type { UserListItem } from "@/features/auth-admin/types/user";
import { useQuery } from "@tanstack/react-query";
import { useAxios } from "@/lib/auth";

const useSearchUsers = (input: string, _searchKey: string, max: number) => {
  const axios = useAxios("auth");

  return useQuery({
    queryKey: ["user-search", input, max],
    queryFn: async (): Promise<UserListItem[]> => {
      const res = await axios.get(`/v1/admin/users`, {
        params: {
          "filter[email]": input,
          "filter[email_op]": "contains",
          "filter[isActive]": "true",
          limit: max,
          sort: "email",
          sortDir: "asc",
        },
      });
      return res.data.data;
    },
    enabled: input.length >= 3,
  });
};

export default useSearchUsers;
