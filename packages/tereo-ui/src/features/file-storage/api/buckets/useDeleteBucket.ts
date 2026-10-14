import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

const useDeleteBucket = () => {
  const axios = useAxios("fileService");
  const queryClient = useQueryClient();

  const mutationFn = async (bucketName: string): Promise<void> => {
    await axios.delete(`/buckets/${bucketName}`);
  };

  return useMutation({
    mutationFn,
    onSuccess: (_data, bucketName) => {
      queryClient.invalidateQueries({ queryKey: ["buckets"] });
      queryClient.invalidateQueries({ queryKey: ["buckets-infinite"] });
      queryClient.invalidateQueries({ queryKey: ["bucket", bucketName] });
      queryClient.invalidateQueries({
        queryKey: ["lifecycle-policy", bucketName],
      });
      queryClient.invalidateQueries({
        queryKey: ["bucket-permissions", bucketName],
      });
      queryClient.invalidateQueries({
        queryKey: ["object-prefixes", bucketName],
      });
      queryClient.invalidateQueries({
        queryKey: [`objects-${bucketName}-infinite`],
      });
      toast.success("Bucket deleted successfully");
    },
    onError: (error: AxiosError<{ error_description?: string }>) => {
      toast.error(
        error.response?.data?.error_description || "Failed to delete bucket"
      );
    },
  });
};

export default useDeleteBucket;
