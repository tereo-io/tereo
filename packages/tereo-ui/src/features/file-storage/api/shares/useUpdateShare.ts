import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { RevealedShare, UpdateShareInput } from "./types";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

interface UseUpdateShareParams {
  id: string;
  data: UpdateShareInput;
}

const useUpdateShare = (bucketName: string) => {
  const axios = useAxios("fileService");
  const queryClient = useQueryClient();

  return useMutation<
    RevealedShare,
    AxiosError<{ error_description?: string }>,
    UseUpdateShareParams
  >({
    mutationFn: async ({ id, data }) => {
      const res = await axios.patch<RevealedShare>(
        `/buckets/${bucketName}/shares/by-id/${id}`,
        data
      );
      return res.data;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: [`shares-${bucketName}-infinite`],
      });
      queryClient.invalidateQueries({
        queryKey: ["share", bucketName, variables.id],
      });
      toast.success("Share updated");
    },
    onError: (error) => {
      toast.error(
        error.response?.data?.error_description || "Failed to update share"
      );
    },
  });
};

export default useUpdateShare;
