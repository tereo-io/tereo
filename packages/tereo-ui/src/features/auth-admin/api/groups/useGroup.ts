import { useQuery } from "@tanstack/react-query";
import { useAxios } from "@/lib/auth";
import type { Group } from "./types";

const useGroup = (id: string, enabled = true) => {
  const axios = useAxios("auth");

  const queryFn = async (): Promise<Group> => {
    const res = await axios.get(`/v1/admin/groups/${id}`);
    return res.data;
  };

  return useQuery({
    queryKey: ["groups", id],
    queryFn,
    enabled: !!id && enabled,
  });
};

export default useGroup;
