import type { Organization, CreateOrganizationInput } from "./types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

const useCreateOrganization = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  const mutationFn = async (
    data: CreateOrganizationInput
  ): Promise<Organization> => {
    const res = await axios.post("/v1/admin/organizations", data);
    return res.data;
  };

  return useMutation({
    mutationFn,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["organizations"] });
      toast.success("Organization created successfully");
    },
    onError: (error: AxiosError<{ error_description?: string }>) => {
      toast.error(
        error.response?.data?.error_description ||
          "Failed to create organization"
      );
    },
  });
};

export default useCreateOrganization;
