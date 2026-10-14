import type { BucketPermission, GrantPermissionInput } from "./types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

interface UseGrantPermissionParams {
  bucketName: string;
  data: GrantPermissionInput;
}

const useGrantPermission = (bucketName: string) => {
  const axios = useAxios("fileService");
  const queryClient = useQueryClient();

  const mutationFn = async ({
    bucketName,
    data,
  }: UseGrantPermissionParams): Promise<BucketPermission> => {
    const res = await axios.post(`/buckets/${bucketName}/permissions`, data);
    return res.data;
  };

  return useMutation({
    mutationFn,
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [`permissions-${bucketName}-infinite`],
      });
      toast.success("Permission granted successfully");
    },
    onError: (error: AxiosError<{ error_description?: string }>) => {
      toast.error(
        error.response?.data?.error_description || "Failed to grant permission"
      );
    },
  });
};

export default useGrantPermission;
