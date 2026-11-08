import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { isAxiosError } from "axios";

const messageFor = (err: unknown): string => {
  if (!isAxiosError(err)) return "Failed to send the email";
  if (err.response?.status === 429)
    return "Too many requests. Try again shortly.";
  if (err.response?.data?.error === "email_not_configured")
    return "Email isn't set up on this deployment.";
  return "Failed to send the email";
};

/** Asks core to mail the signed-in user a fresh confirmation link. */
const useResendVerification = () => {
  const axios = useAxios("auth");
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<void> => {
      await axios.post("/v1/account/email-verification");
    },
    onSuccess: () => toast.success("Confirmation email sent"),
    onError: async (err) => {
      // already_verified means the profile on screen is stale.
      if (
        isAxiosError(err) &&
        err.response?.data?.error === "already_verified"
      ) {
        await queryClient.invalidateQueries({
          queryKey: ["account", "profile"],
        });
        return;
      }
      toast.error(messageFor(err));
    },
  });
};

export default useResendVerification;
