import { useQuery } from "@tanstack/react-query";
import type { ServiceDetail } from "./types";
import { useAxios } from "@/lib/auth";

const useService = (id: string) => {
  const axios = useAxios("auth");

  const queryFn = async (): Promise<ServiceDetail> => {
    const res = await axios.get(`/v1/admin/services/${id}`);
    return res.data;
  };

  return useQuery({
    queryKey: ["services", id],
    queryFn,
    enabled: !!id,
  });
};

export default useService;
