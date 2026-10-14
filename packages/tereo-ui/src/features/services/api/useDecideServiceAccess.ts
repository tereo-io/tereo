import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AccessDecisionInput, ApiErrorBody } from "./types";
import invalidateServices from "./invalidateServices";
import type { AxiosError } from "axios";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";

export type AccessDecision = "approve" | "revoke";

const MAX_IDS_PER_REQUEST = 100;

const MESSAGES: Record<AccessDecision, { done: string; failed: string }> = {
  approve: { done: "Access approved", failed: "Failed to approve access" },
  revoke: { done: "Access revoked", failed: "Failed to revoke access" },
};

/** Approve or revoke a service's access requests by id. */
const useDecideServiceAccess = (decision: AccessDecision) => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  // Core takes at most 100 ids a request. Chunks go one after another, so a
  // failure leaves the earlier chunks decided and the rest pending.
  const mutationFn = async ({ serviceId, ids }: AccessDecisionInput) => {
    for (let i = 0; i < ids.length; i += MAX_IDS_PER_REQUEST) {
      await axios.post(`/v1/admin/services/${serviceId}/access/${decision}`, {
        ids: ids.slice(i, i + MAX_IDS_PER_REQUEST),
      });
    }
  };

  return useMutation({
    mutationFn,
    onSuccess: async () => {
      await invalidateServices(queryClient);
      toast.success(MESSAGES[decision].done);
    },
    onError: async (error: AxiosError<ApiErrorBody>) => {
      // Earlier chunks may have gone through.
      await invalidateServices(queryClient);
      toast.error(
        error.response?.data?.error_description || MESSAGES[decision].failed
      );
    },
  });
};

export default useDecideServiceAccess;
