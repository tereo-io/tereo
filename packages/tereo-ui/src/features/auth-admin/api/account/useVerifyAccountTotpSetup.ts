import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAxios } from "@/lib/auth";

interface VerifyParams {
  setupToken: string;
  totpCode: string;
}

interface VerifyResponse {
  success: boolean;
  recoveryCodes: string[];
  message: string;
}

const useVerifyAccountTotpSetup = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  return useMutation({
    mutationFn: async (params: VerifyParams): Promise<VerifyResponse> => {
      const res = await axios.post("/v1/account/totp/setup/verify", params);
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["account", "totp"] });
      queryClient.invalidateQueries({ queryKey: ["account", "profile"] });
      queryClient.invalidateQueries({ queryKey: ["account", "sessions"] });
    },
  });
};

export default useVerifyAccountTotpSetup;
