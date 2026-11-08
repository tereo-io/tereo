import { useMutation, useQueryClient } from "@tanstack/react-query";
import { brandingErrorMessage } from "./brandingErrors";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";

const useRevokeBrandingGrant = (clientId: string) => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  const mutationFn = async (userId: string): Promise<void> => {
    await axios.delete(
      `/v1/admin/branding/clients/${clientId}/grants/${userId}`
    );
  };

  return useMutation({
    mutationFn,
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["branding", "grants", clientId],
      });
      toast.success("Edit access revoked");
    },
    onError: (error) => {
      toast.error(brandingErrorMessage(error, "Failed to revoke edit access"));
    },
  });
};

export default useRevokeBrandingGrant;
