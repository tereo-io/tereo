import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ApiErrorBody, RegeneratedSecret } from "./types";
import invalidateServices from "./invalidateServices";
import type { AxiosError } from "axios";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";

const useRegenerateServiceSecret = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  const mutationFn = async (id: string): Promise<RegeneratedSecret> => {
    const res = await axios.post(`/v1/admin/services/${id}/regenerate-secret`);
    return res.data;
  };

  return useMutation({
    mutationFn,
    onSuccess: () => invalidateServices(queryClient),
    onError: (error: AxiosError<ApiErrorBody>) => {
      toast.error(
        error.response?.data?.error_description || "Failed to regenerate secret"
      );
    },
  });
};

export default useRegenerateServiceSecret;
