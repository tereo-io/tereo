import { useMutation } from "@tanstack/react-query";
import { usePublicAxios } from "@/lib/auth";

const useForcedPasswordChange = () => {
  const axios = usePublicAxios("auth");
  return useMutation({
    mutationFn: async (params: {
      changeGrant: string;
      password: string;
    }): Promise<void> => {
      await axios.post(
        "/oauth/password-change",
        { change_grant: params.changeGrant, password: params.password },
        { headers: { Accept: "application/json" }, withCredentials: true }
      );
    },
  });
};

export default useForcedPasswordChange;
