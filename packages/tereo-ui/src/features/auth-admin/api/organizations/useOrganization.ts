import { useQuery } from "@tanstack/react-query";
import type { Organization } from "./types";
import { useAxios } from "@/lib/auth";

const useOrganization = (id: string) => {
  const axios = useAxios("auth");

  const queryFn = async (): Promise<Organization> => {
    const res = await axios.get(`/v1/admin/organizations/${id}`);
    return res.data;
  };

  return useQuery({ queryKey: ["organizations", id], queryFn, enabled: !!id });
};

export default useOrganization;
