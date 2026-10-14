import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Bucket, CreateBucketInput } from "./types";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

const useCreateBucket = () => {
  const axios = useAxios("fileService");
  const queryClient = useQueryClient();

  const mutationFn = async (data: CreateBucketInput): Promise<Bucket> => {
    const res = await axios.post(`/buckets`, data);
    return res.data;
  };

  return useMutation({
    mutationFn,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`buckets`] });
      queryClient.invalidateQueries({ queryKey: ["buckets-infinite"] });
      toast.success("Bucket created successfully");
    },
    onError: (error: AxiosError<{ error_description?: string }>) => {
      toast.error(
        error.response?.data?.error_description || "Failed to create bucket"
      );
    },
  });
};

export default useCreateBucket;
