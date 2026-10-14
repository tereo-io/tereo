import type { LifecyclePolicy, UpsertLifecyclePolicyInput } from "./types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

const useUpsertLifecyclePolicy = (bucketName: string | undefined) => {
  const axios = useAxios("fileService");
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: UpsertLifecyclePolicyInput) => {
      const response = await axios.put<LifecyclePolicy>(
        `/buckets/${bucketName}/lifecycle`,
        input
      );
      return response.data;
    },
    onSuccess: () => {
      toast.success("Lifecycle policy saved");
      queryClient.invalidateQueries({
        queryKey: ["lifecycle-policy", bucketName],
      });
      queryClient.invalidateQueries({
        queryKey: ["bucket", bucketName],
      });
    },
    onError: (error: AxiosError<{ error_description?: string }>) => {
      toast.error(
        error.response?.data?.error_description || "Failed to save policy"
      );
    },
  });
};

export default useUpsertLifecyclePolicy;
