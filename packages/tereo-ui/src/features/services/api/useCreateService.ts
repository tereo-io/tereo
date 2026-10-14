import type { ApiErrorBody, CreatedService, CreateServiceInput } from "./types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import invalidateServices from "./invalidateServices";
import type { AxiosError } from "axios";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";

const useCreateService = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  const mutationFn = async (
    data: CreateServiceInput
  ): Promise<CreatedService> => {
    const res = await axios.post("/v1/admin/services", data);
    return res.data;
  };

  return useMutation({
    mutationFn,
    onSuccess: () => invalidateServices(queryClient),
    onError: (error: AxiosError<ApiErrorBody>) => {
      toast.error(
        error.response?.data?.error_description || "Failed to add service"
      );
    },
  });
};

export default useCreateService;
