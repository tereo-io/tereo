import { useMutation } from "@tanstack/react-query";
import { usePublicAxios } from "@/lib/auth";

interface InitiateTotpSetupParams {
  setupGrant: string;
}

interface InitiateTotpSetupResponse {
  secret: string;
  qrCodeUri: string;
  setupToken: string;
  expiresAt: string;
}

const useInitiateTotpSetup = () => {
  const axios = usePublicAxios("auth");
  return useMutation({
    mutationFn: async (
      params: InitiateTotpSetupParams
    ): Promise<InitiateTotpSetupResponse> => {
      const res = await axios.post(
        `/oauth/totp/setup`,
        { setup_grant: params.setupGrant },
        {
          headers: { Accept: "application/json" },
          withCredentials: true,
        }
      );
      return res.data;
    },
  });
};

export default useInitiateTotpSetup;
