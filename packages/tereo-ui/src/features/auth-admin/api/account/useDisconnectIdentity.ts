import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";

const useDisconnectIdentity = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  return useMutation({
    mutationFn: async (identityId: string) => {
      await axios.delete(`/v1/account/identities/${identityId}`);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["account", "identities"],
      });
      toast.success("Account disconnected");
    },
  });
};

export default useDisconnectIdentity;
