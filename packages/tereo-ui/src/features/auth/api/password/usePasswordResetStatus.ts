import { useQuery } from "@tanstack/react-query";
import { usePublicAxios } from "@/lib/auth";

/** Whether this deploy can send reset links; the sign-in page offers one only then. */
const usePasswordResetStatus = () => {
  const axios = usePublicAxios("auth");
  return useQuery({
    queryKey: ["password-reset", "status"],
    staleTime: 60_000,
    queryFn: async (): Promise<{ enabled: boolean }> => {
      const res = await axios.get("/v1/password-reset/status");
      return res.data;
    },
  });
};

export default usePasswordResetStatus;
