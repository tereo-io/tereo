import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";

interface DisableParams {
  totpCode: string;
}

const useDisableAccountTotp = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  return useMutation({
    mutationFn: async (params: DisableParams): Promise<void> => {
      await axios.delete("/v1/account/totp", { data: params });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["account", "totp"] });
      queryClient.invalidateQueries({ queryKey: ["account", "profile"] });
      queryClient.invalidateQueries({ queryKey: ["account", "sessions"] });
      toast.success("Two-factor authentication disabled");
    },
  });
};

export default useDisableAccountTotp;
