import type { NotificationConnection, UpdateConnectionInput } from "../types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { errorMessage, type CoreError } from "../errorMessage";
import { CONNECTIONS_KEY } from "./useConnections";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";

/** `PATCH /v1/admin/notifications/connections/:id` — omitted fields keep their value, secrets included. */
const useUpdateConnection = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  const mutationFn = async ({
    id,
    data,
  }: {
    id: string;
    data: UpdateConnectionInput;
  }): Promise<NotificationConnection> => {
    const res = await axios.patch(
      `/v1/admin/notifications/connections/${id}`,
      data
    );
    return res.data;
  };

  return useMutation({
    mutationFn,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: CONNECTIONS_KEY });
      toast.success("Connection updated");
    },
    onError: (error: CoreError) => {
      toast.error(errorMessage(error, "Failed to update connection"));
    },
  });
};

export default useUpdateConnection;
