import { useMutation } from "@tanstack/react-query";
import { usePublicAxios } from "@/lib/auth";

const useConfirmEmail = () => {
  const axios = usePublicAxios("auth");
  return useMutation({
    mutationFn: async (token: string): Promise<void> => {
      await axios.post("/v1/email-verification", { token });
    },
  });
};

export default useConfirmEmail;
