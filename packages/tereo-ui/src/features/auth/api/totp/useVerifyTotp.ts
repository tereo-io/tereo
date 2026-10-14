import { useMutation } from "@tanstack/react-query";
import { usePublicAxios } from "@/lib/auth";
import { redirectTo } from "../redirectTo";

interface VerifyTotpParams {
  sessionToken: string;
  totpCode: string;
}

interface VerifyTotpResponse {
  redirect_url?: string;
}

const useVerifyTotp = () => {
  const axios = usePublicAxios("auth");
  return useMutation({
    mutationFn: async ({
      sessionToken,
      totpCode,
    }: VerifyTotpParams): Promise<VerifyTotpResponse> => {
      const res = await axios.post<VerifyTotpResponse>(
        `/oauth/totp/verify`,
        new URLSearchParams({
          session_token: sessionToken,
          totp_code: totpCode,
        }),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          withCredentials: true,
        }
      );
      return res.data;
    },
    onSuccess: (data) => {
      if (data.redirect_url) redirectTo(data.redirect_url);
    },
  });
};

export default useVerifyTotp;
