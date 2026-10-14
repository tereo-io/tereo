import { useMutation, useQueryClient } from "@tanstack/react-query";
import invalidateServices from "./invalidateServices";
import type { ApiErrorBody, Service } from "./types";
import type { AxiosError } from "axios";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";

const useRevokePreviousSecret = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  const mutationFn = async (id: string): Promise<Service> => {
    const res = await axios.post(
      `/v1/admin/services/${id}/revoke-previous-secret`
    );
    return res.data;
  };

  return useMutation({
    mutationFn,
    onSuccess: async () => {
      await invalidateServices(queryClient);
      toast.success("Previous secret revoked");
    },
    onError: (error: AxiosError<ApiErrorBody>) => {
      toast.error(
        error.response?.data?.error_description ||
          "Failed to revoke the previous secret"
      );
    },
  });
};

export default useRevokePreviousSecret;
