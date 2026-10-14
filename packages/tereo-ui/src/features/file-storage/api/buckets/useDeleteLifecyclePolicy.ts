import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

const useDeleteLifecyclePolicy = (bucketName: string | undefined) => {
  const axios = useAxios("fileService");
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      await axios.delete(`/buckets/${bucketName}/lifecycle`);
    },
    onSuccess: () => {
      toast.success("Lifecycle policy removed");
      queryClient.invalidateQueries({
        queryKey: ["lifecycle-policy", bucketName],
      });
      queryClient.invalidateQueries({
        queryKey: ["bucket", bucketName],
      });
    },
    onError: (error: AxiosError<{ error_description?: string }>) => {
      toast.error(
        error.response?.data?.error_description || "Failed to remove policy"
      );
    },
  });
};

export default useDeleteLifecyclePolicy;
