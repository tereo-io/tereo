import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ProviderDomain, ProviderDomainInput } from "./types";
import { identityErrorMessage } from "./errors";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";

interface SaveDomainParams {
  providerId: string;
  /** Set to edit a domain; unset to add one. */
  domainId?: string;
  data: Partial<ProviderDomainInput>;
}

const useSaveProviderDomain = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  return useMutation({
    mutationFn: async ({
      providerId,
      domainId,
      data,
    }: SaveDomainParams): Promise<ProviderDomain> => {
      const base = `/v1/admin/identity-providers/${providerId}/domains`;
      const res = domainId
        ? await axios.patch(`${base}/${domainId}`, data)
        : await axios.post(base, data);
      return res.data;
    },
    onSuccess: async (_, variables) => {
      await queryClient.invalidateQueries({
        queryKey: ["identity-providers", variables.providerId, "domains"],
      });
      toast.success(variables.domainId ? "Domain updated" : "Domain added");
    },
    onError: (error) => {
      toast.error(identityErrorMessage(error, "Failed to save the domain"));
    },
  });
};

export default useSaveProviderDomain;
