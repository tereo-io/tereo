import type { ApiErrorBody, Service, UpdateServiceInput } from "./types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import invalidateServices from "./invalidateServices";
import type { AxiosError } from "axios";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";

interface UpdateServiceVariables {
  id: string;
  data: UpdateServiceInput;
}

const useUpdateService = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  const mutationFn = async ({
    id,
    data,
  }: UpdateServiceVariables): Promise<Service> => {
    const res = await axios.patch(`/v1/admin/services/${id}`, data);
    return res.data;
  };

  return useMutation({
    mutationFn,
    onSuccess: () => invalidateServices(queryClient),
    onError: (error: AxiosError<ApiErrorBody>) => {
      toast.error(
        error.response?.data?.error_description || "Failed to update service"
      );
    },
  });
};

export default useUpdateService;
