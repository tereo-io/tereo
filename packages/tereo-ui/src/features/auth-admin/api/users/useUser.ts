import { useQuery } from "@tanstack/react-query";
import { useAxios } from "@/lib/auth";
import type { User } from "./types";

const useUser = (id: string) => {
  const axios = useAxios("auth");

  const queryFn = async (): Promise<User> => {
    const res = await axios.get(`/v1/admin/users/${id}`);
    return res.data;
  };

  return useQuery({
    queryKey: ["users", id],
    queryFn,
    enabled: !!id,
  });
};

export default useUser;
