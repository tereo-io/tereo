import { useInfiniteCursor } from "@kosmeo-ui/react";
import { useAxios } from "@/lib/auth";
import { User } from "./types";

const useInfiniteUsers = () => {
  const axios = useAxios("auth");
  return useInfiniteCursor<User>({
    axiosInstance: axios,
    endpoint: "/v1/admin/users",
    queryKey: "users",
  });
};

export default useInfiniteUsers;
