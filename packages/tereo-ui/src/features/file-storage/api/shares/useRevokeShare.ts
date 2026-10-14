import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

const useRevokeShare = (bucketName: string) => {
  const axios = useAxios("fileService");
  const queryClient = useQueryClient();

  return useMutation<void, AxiosError, string>({
    mutationFn: async (id) => {
      await axios.delete(`/buckets/${bucketName}/shares/by-id/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [`shares-${bucketName}-infinite`],
      });
      toast.success("Share revoked");
    },
    onError: (error) => {
      const data = error.response?.data as
        { error_description?: string } | undefined;
      toast.error(data?.error_description || "Failed to revoke share");
    },
  });
};

export default useRevokeShare;
