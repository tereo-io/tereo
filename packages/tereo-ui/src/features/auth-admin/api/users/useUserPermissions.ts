import { useQuery } from "@tanstack/react-query";
import { useAxios } from "@/lib/auth";

const useUserPermissions = (userId: string) => {
  const axios = useAxios("auth");

  const queryFn = async (): Promise<{
    userId: string;
    permissions: string[];
  }> => {
    const res = await axios.get(`/v1/admin/users/${userId}/permissions`);
    return res.data;
  };

  return useQuery({
    queryKey: ["users", userId, "permissions"],
    queryFn,
    enabled: !!userId,
  });
};

export default useUserPermissions;
