import { useMutation, useQueryClient } from "@tanstack/react-query";
import { errorMessage, type CoreError } from "../errorMessage";
import { LOG_KEY } from "./useInfiniteNotificationLog";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";

/**
 * `POST /v1/admin/notifications/:id/retry` (`notifications.admin`) — requeues
 * the failed deliveries. With none failed core answers `409 nothing_to_retry`
 * (someone else may have retried first), so the log is refreshed and the
 * admin told, not shown an error.
 */
const useRetryNotification = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  const refresh = () => queryClient.invalidateQueries({ queryKey: [LOG_KEY] });

  return useMutation({
    mutationFn: async (id: string): Promise<{ requeued: number }> => {
      const res = await axios.post(`/v1/admin/notifications/${id}/retry`);
      return res.data;
    },
    onSuccess: async ({ requeued }) => {
      await refresh();
      toast.success(
        requeued === 1
          ? "1 delivery queued for retry"
          : `${requeued} deliveries queued for retry`
      );
    },
    onError: async (error: CoreError) => {
      if (error.response?.data?.error === "nothing_to_retry") {
        await refresh();
        toast.info("No failed deliveries to retry");
        return;
      }
      toast.error(errorMessage(error, "Failed to retry notification"));
    },
  });
};

export default useRetryNotification;
