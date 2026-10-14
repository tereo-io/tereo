import { useMutation, useQueryClient } from "@tanstack/react-query";
import { isReauthRequired } from "@/features/auth";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

interface RegenerateParams {
  totpCode: string;
}

interface RegenerateResponse {
  recoveryCodes: string[];
  message: string;
}

const useRegenerateAccountRecoveryCodes = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  return useMutation({
    mutationFn: async (
      params: RegenerateParams
    ): Promise<RegenerateResponse> => {
      const res = await axios.post("/v1/account/totp/recovery-codes", {
        totpCode: params.totpCode,
      });
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["account", "totp"] });
      queryClient.invalidateQueries({ queryKey: ["account", "profile"] });
      toast.success("Recovery codes regenerated");
    },
    onError: (error: AxiosError<{ error_description?: string }>) => {
      // The button signs in again instead.
      if (isReauthRequired(error)) return;
      toast.error(
        error.response?.data?.error_description ||
          "Failed to regenerate recovery codes"
      );
    },
  });
};

export default useRegenerateAccountRecoveryCodes;
