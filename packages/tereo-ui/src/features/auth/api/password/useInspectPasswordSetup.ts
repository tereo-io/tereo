import { useQuery } from "@tanstack/react-query";
import { usePublicAxios } from "@/lib/auth";

export interface PasswordSetupDetails {
  email: string;
  name: string | null;
  expiresAt: string;
}

/** Inspecting uses nothing up, so it is safe to repeat. */
const useInspectPasswordSetup = (token: string) => {
  const axios = usePublicAxios("auth");
  return useQuery({
    queryKey: ["password-setup", token],
    enabled: !!token,
    retry: false,
    staleTime: Infinity,
    queryFn: async (): Promise<PasswordSetupDetails> => {
      const res = await axios.post("/v1/password-setup/inspect", { token });
      return res.data;
    },
  });
};

export default useInspectPasswordSetup;
