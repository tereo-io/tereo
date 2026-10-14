import { useMutation, useQueryClient } from "@tanstack/react-query";
import { errorMessage, type CoreError } from "../errorMessage";
import { CONNECTIONS_KEY } from "./useConnections";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";

/** `DELETE /v1/admin/notifications/connections/:id` — 409 `connection_in_use` once anything references it. */
const useDeleteConnection = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  const mutationFn = async (id: string): Promise<void> => {
    await axios.delete(`/v1/admin/notifications/connections/${id}`);
  };

  return useMutation({
    mutationFn,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: CONNECTIONS_KEY });
      toast.success("Connection deleted");
    },
    onError: (error: CoreError) => {
      toast.error(errorMessage(error, "Failed to delete connection"));
    },
  });
};

export default useDeleteConnection;
