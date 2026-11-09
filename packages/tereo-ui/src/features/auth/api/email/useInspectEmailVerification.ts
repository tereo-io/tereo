import { useQuery } from "@tanstack/react-query";
import { usePublicAxios } from "@/lib/auth";

export interface EmailVerificationDetails {
  email: string;
  expiresAt: string;
}

/** Inspecting consumes nothing; any failure reads as an unusable link. */
const useInspectEmailVerification = (token: string) => {
  const axios = usePublicAxios("auth");
  return useQuery({
    queryKey: ["email-verification", token],
    enabled: !!token,
    retry: false,
    staleTime: Infinity,
    queryFn: async (): Promise<EmailVerificationDetails> => {
      const res = await axios.post("/v1/email-verification/inspect", { token });
      return res.data;
    },
  });
};

export default useInspectEmailVerification;
