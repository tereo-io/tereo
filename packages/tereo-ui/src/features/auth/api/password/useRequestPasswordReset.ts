import { useMutation } from "@tanstack/react-query";
import { usePublicAxios } from "@/lib/auth";

const useRequestPasswordReset = () => {
  const axios = usePublicAxios("auth");
  return useMutation({
    mutationFn: async (params: {
      email: string;
      clientId?: string;
    }): Promise<void> => {
      await axios.post("/v1/password-reset", {
        email: params.email,
        ...(params.clientId ? { client_id: params.clientId } : {}),
      });
    },
  });
};

export default useRequestPasswordReset;
