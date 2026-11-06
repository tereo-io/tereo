import { useMutation } from "@tanstack/react-query";
import { usePublicAxios } from "@/lib/auth";

const useSetPassword = () => {
  const axios = usePublicAxios("auth");
  return useMutation({
    mutationFn: async (params: {
      token: string;
      password: string;
    }): Promise<void> => {
      await axios.post("/v1/password-setup", params);
    },
  });
};

export default useSetPassword;
