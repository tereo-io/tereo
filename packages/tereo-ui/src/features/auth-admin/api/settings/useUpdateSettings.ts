import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SystemSettings, UpdateSettingsInput } from "./types";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

const useUpdateSettings = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  return useMutation({
    mutationFn: async (data: UpdateSettingsInput): Promise<SystemSettings> => {
      const res = await axios.patch("/v1/admin/settings", data);
      return res.data;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["settings"], data);
      toast.success("Settings updated successfully");
    },
    onError: (error: AxiosError<{ error_description?: string }>) => {
      toast.error(
        error.response?.data?.error_description || "Failed to update settings"
      );
    },
  });
};

export default useUpdateSettings;
