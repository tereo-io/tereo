import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { isAxiosError } from "axios";

const messageFor = (err: unknown): string => {
  const code = isAxiosError(err) ? err.response?.data?.error : undefined;
  if (code === "already_verified") return "This address is already verified";
  if (code === "email_not_configured")
    return "Email isn't set up on this deployment";
  if (code === "user_not_verifiable")
    return "This account can't receive a verification email";
  return "Failed to send the verification email";
};

/** Mails a user a fresh confirmation link for their current address. */
const useSendVerificationEmail = () => {
  const axios = useAxios("auth");
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string): Promise<void> => {
      await axios.post(`/v1/admin/users/${userId}/email-verification`);
    },
    onSuccess: () => toast.success("Verification email sent"),
    onError: async (err, userId) => {
      toast.error(messageFor(err));
      await queryClient.invalidateQueries({ queryKey: ["users", userId] });
    },
  });
};

export default useSendVerificationEmail;
