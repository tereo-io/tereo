import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

const useDeletePhoto = () => {
  const axios = useAxios("auth");
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (): Promise<void> => {
      await axios.delete("/v1/account/photo");
    },
    onSuccess: () => {
      toast.success("Profile photo removed");
      queryClient.invalidateQueries({ queryKey: ["account", "profile"] });
    },
    onError: (error: AxiosError<{ error_description?: string }>) => {
      toast.error(
        error.response?.data?.error_description || "Failed to remove photo"
      );
    },
  });
};

export default useDeletePhoto;
