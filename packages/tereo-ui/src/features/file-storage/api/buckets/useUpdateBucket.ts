import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Bucket, UpdateBucketInput } from "./types";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

interface UseUpdateBucketParams {
  bucketName: string;
  data: UpdateBucketInput;
}

const useUpdateBucket = () => {
  const axios = useAxios("fileService");
  const queryClient = useQueryClient();

  const mutationFn = async ({
    bucketName,
    data,
  }: UseUpdateBucketParams): Promise<Bucket> => {
    const res = await axios.put(`/buckets/${bucketName}`, data);
    return res.data;
  };

  return useMutation({
    mutationFn,
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["buckets"] });
      queryClient.invalidateQueries({ queryKey: ["buckets-infinite"] });
      queryClient.invalidateQueries({
        queryKey: ["bucket", variables.bucketName],
      });
      toast.success("Bucket updated successfully");
    },
    onError: (error: AxiosError<{ error_description?: string }>) => {
      toast.error(
        error.response?.data?.error_description || "Failed to update bucket"
      );
    },
  });
};

export default useUpdateBucket;
