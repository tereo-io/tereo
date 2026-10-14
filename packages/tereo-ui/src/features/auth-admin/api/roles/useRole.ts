import { useQuery } from "@tanstack/react-query";
import { useAxios } from "@/lib/auth";
import type { Role } from "./types";

const useRole = (id: string) => {
  const axios = useAxios("auth");

  const queryFn = async (): Promise<Role> => {
    const res = await axios.get(`/v1/admin/roles/${id}`);
    return res.data;
  };

  return useQuery({
    queryKey: ["roles", id],
    queryFn,
    enabled: !!id,
  });
};

export default useRole;
