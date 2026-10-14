import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { OAuthClientWithSecret } from "./types";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

const useRegenerateClientSecret = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  const mutationFn = async (id: string): Promise<OAuthClientWithSecret> => {
    const res = await axios.post(`/v1/admin/clients/${id}/regenerate-secret`);
    return res.data;
  };

  return useMutation({
    mutationFn,
    onSuccess: async (_, id) => {
      await queryClient.invalidateQueries({ queryKey: ["clients", id] });
    },
    onError: (error: AxiosError<{ error_description?: string }>) => {
      toast.error(
        error.response?.data?.error_description || "Failed to regenerate secret"
      );
    },
  });
};

export default useRegenerateClientSecret;
