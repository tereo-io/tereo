import type { CreateConnectionInput, NotificationConnection } from "../types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { errorMessage, type CoreError } from "../errorMessage";
import { CONNECTIONS_KEY } from "./useConnections";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";

/** `POST /v1/admin/notifications/connections` */
const useCreateConnection = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  const mutationFn = async (
    data: CreateConnectionInput
  ): Promise<NotificationConnection> => {
    const res = await axios.post("/v1/admin/notifications/connections", data);
    return res.data;
  };

  return useMutation({
    mutationFn,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: CONNECTIONS_KEY });
      toast.success("Connection created");
    },
    onError: (error: CoreError) => {
      toast.error(errorMessage(error, "Failed to create connection"));
    },
  });
};

export default useCreateConnection;
