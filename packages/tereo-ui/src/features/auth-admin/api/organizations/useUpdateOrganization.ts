import type { Organization, UpdateOrganizationInput } from "./types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

const useUpdateOrganization = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  const mutationFn = async (data: {
    id: string;
    updateData: UpdateOrganizationInput;
  }): Promise<Organization> => {
    const res = await axios.patch(
      `/v1/admin/organizations/${data.id}`,
      data.updateData
    );
    return res.data;
  };

  return useMutation({
    mutationFn,
    onSuccess: async (_, variables) => {
      await queryClient.invalidateQueries({
        queryKey: ["organizations", variables.id],
      });
      await queryClient.invalidateQueries({ queryKey: ["organizations"] });
      toast.success("Organization updated successfully");
    },
    onError: (error: AxiosError<{ error_description?: string }>) => {
      toast.error(
        error.response?.data?.error_description ||
          "Failed to update organization"
      );
    },
  });
};

export default useUpdateOrganization;
