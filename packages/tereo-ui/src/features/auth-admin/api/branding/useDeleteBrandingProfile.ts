import { useMutation, useQueryClient } from "@tanstack/react-query";
import { targetPath, type BrandingTarget } from "./types";
import { brandingErrorMessage } from "./brandingErrors";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";

const useDeleteBrandingProfile = (target: BrandingTarget) => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  const mutationFn = async (): Promise<void> => {
    await axios.delete(targetPath(target));
  };

  return useMutation({
    mutationFn,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["branding"] });
      toast.success("Branding removed");
    },
    onError: (error) => {
      toast.error(brandingErrorMessage(error, "Failed to remove branding"));
    },
  });
};

export default useDeleteBrandingProfile;
