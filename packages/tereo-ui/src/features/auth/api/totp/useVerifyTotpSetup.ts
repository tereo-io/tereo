import { useMutation } from "@tanstack/react-query";
import { usePublicAxios } from "@/lib/auth";

interface VerifyTotpSetupParams {
  setupToken: string;
  totpCode: string;
}

interface VerifyTotpSetupResponse {
  success: boolean;
  recoveryCodes: string[];
  message: string;
}

const useVerifyTotpSetup = () => {
  const axios = usePublicAxios("auth");
  return useMutation({
    mutationFn: async (
      params: VerifyTotpSetupParams
    ): Promise<VerifyTotpSetupResponse> => {
      const res = await axios.post(
        `/oauth/totp/setup/verify`,
        {
          setup_token: params.setupToken,
          totp_code: params.totpCode,
        },
        {
          headers: { Accept: "application/json" },
          withCredentials: true,
        }
      );
      return res.data;
    },
  });
};

export default useVerifyTotpSetup;
