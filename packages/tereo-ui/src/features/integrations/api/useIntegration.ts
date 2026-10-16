import { useQuery } from "@tanstack/react-query";
import type { Integration } from "./types";
import { useAxios } from "@/lib/auth";

const useIntegration = (id: string) => {
  const axios = useAxios("auth");

  const queryFn = async (): Promise<Integration> => {
    const res = await axios.get(`/v1/admin/integrations/${id}`);
    return res.data;
  };

  return useQuery({
    queryKey: ["integrations", id],
    queryFn,
    enabled: !!id,
  });
};

export default useIntegration;
