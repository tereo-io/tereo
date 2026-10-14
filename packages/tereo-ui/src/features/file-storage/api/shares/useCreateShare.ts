import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CreateShareInput, RevealedShare } from "./types";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

const useCreateShare = (bucketName: string) => {
  const axios = useAxios("fileService");
  const queryClient = useQueryClient();

  return useMutation<RevealedShare, AxiosError, CreateShareInput>({
    mutationFn: async (input) => {
      const res = await axios.post<RevealedShare>(
        `/buckets/${bucketName}/shares`,
        input
      );
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [`shares-${bucketName}-infinite`],
      });
      toast.success("Share created");
    },
    onError: (error) => {
      const data = error.response?.data as
        { error_description?: string } | undefined;
      toast.error(data?.error_description || "Failed to create share");
    },
  });
};

export default useCreateShare;
