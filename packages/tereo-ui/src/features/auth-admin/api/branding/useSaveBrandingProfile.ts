import { useMutation, useQueryClient } from "@tanstack/react-query";
import { brandingErrorMessage } from "./brandingErrors";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import {
  targetPath,
  type AdminProfileBody,
  type BrandingTarget,
} from "./types";

const useSaveBrandingProfile = (target: BrandingTarget) => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  const mutationFn = async (body: AdminProfileBody): Promise<void> => {
    await axios.put(targetPath(target), body);
  };

  return useMutation({
    mutationFn,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["branding"] });
      toast.success("Branding saved");
    },
    onError: (error) => {
      toast.error(brandingErrorMessage(error, "Failed to save branding"));
    },
  });
};

export default useSaveBrandingProfile;
