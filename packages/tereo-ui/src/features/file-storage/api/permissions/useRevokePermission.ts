import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

interface UseRevokePermissionParams {
  bucketName: string;
  userId: string;
}

const useRevokePermission = (bucketName: string) => {
  const axios = useAxios("fileService");
  const queryClient = useQueryClient();

  const mutationFn = async ({
    bucketName,
    userId,
  }: UseRevokePermissionParams): Promise<void> => {
    await axios.delete(`/buckets/${bucketName}/permissions/${userId}`);
  };

  return useMutation({
    mutationFn,
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [`permissions-${bucketName}-infinite`],
      });
      toast.success("Permission revoked successfully");
    },
    onError: (error: AxiosError<{ error_description?: string }>) => {
      toast.error(
        error.response?.data?.error_description || "Failed to revoke permission"
      );
    },
  });
};

export default useRevokePermission;
