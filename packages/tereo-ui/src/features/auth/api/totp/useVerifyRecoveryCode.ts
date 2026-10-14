import { useMutation } from "@tanstack/react-query";
import { usePublicAxios } from "@/lib/auth";
import { redirectTo } from "../redirectTo";

interface VerifyRecoveryCodeParams {
  sessionToken: string;
  recoveryCode: string;
}

interface VerifyRecoveryCodeResponse {
  redirect_url?: string;
}

const useVerifyRecoveryCode = () => {
  const axios = usePublicAxios("auth");
  return useMutation({
    mutationFn: async ({
      sessionToken,
      recoveryCode,
    }: VerifyRecoveryCodeParams): Promise<VerifyRecoveryCodeResponse> => {
      const res = await axios.post<VerifyRecoveryCodeResponse>(
        `/oauth/totp/recovery`,
        new URLSearchParams({
          session_token: sessionToken,
          recovery_code: recoveryCode,
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

export default useVerifyRecoveryCode;
