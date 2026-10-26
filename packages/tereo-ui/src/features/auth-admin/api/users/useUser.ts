import { useQuery } from "@tanstack/react-query";
import type { UserDetail } from "./types";
import { useAxios } from "@/lib/auth";

const useUser = (id: string) => {
  const axios = useAxios("auth");

  const queryFn = async (): Promise<UserDetail> => {
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
