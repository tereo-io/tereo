import { useMutation } from "@tanstack/react-query";
import { useAxios } from "@/lib/auth";

export interface AccountTotpSetup {
  secret: string;
  qrCodeUri: string;
  /** Sent back with the first code; valid until `expiresAt`. */
  setupToken: string;
  expiresAt: string;
}

const useInitiateAccountTotpSetup = () => {
  const axios = useAxios("auth");

  return useMutation({
    mutationFn: async (): Promise<AccountTotpSetup> => {
      const res = await axios.post("/v1/account/totp/setup");
      return res.data;
    },
  });
};

export default useInitiateAccountTotpSetup;
