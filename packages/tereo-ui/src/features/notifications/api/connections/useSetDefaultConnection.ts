import { useMutation, useQueryClient } from "@tanstack/react-query";
import { errorMessage, type CoreError } from "../errorMessage";
import { CONNECTIONS_KEY } from "./useConnections";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";

/** `POST /v1/admin/notifications/connections/:id/default` */
const useSetDefaultConnection = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  const mutationFn = async (id: string): Promise<void> => {
    await axios.post(`/v1/admin/notifications/connections/${id}/default`);
  };

  return useMutation({
    mutationFn,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: CONNECTIONS_KEY });
      toast.success("Default connection changed");
    },
    onError: (error: CoreError) => {
      toast.error(errorMessage(error, "Failed to change the default"));
    },
  });
};

export default useSetDefaultConnection;
