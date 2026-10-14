import { identityErrorMessage } from "../identity-providers/errors";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";

/** Invites a user to sign in through a provider, or withdraws the invite. */
const useUserIdentityInvite = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  const invalidate = (userId: string) =>
    queryClient.invalidateQueries({
      queryKey: ["users", userId, "identities"],
    });

  const invite = useMutation({
    mutationFn: async (data: { userId: string; providerId: string }) => {
      await axios.post(`/v1/admin/users/${data.userId}/identity-invites`, {
        providerId: data.providerId,
      });
    },
    onSuccess: async (_, variables) => {
      await invalidate(variables.userId);
      toast.success("Invite created");
    },
    onError: (error) => {
      toast.error(identityErrorMessage(error, "Failed to create the invite"));
    },
  });

  const revoke = useMutation({
    mutationFn: async (data: { userId: string; providerId: string }) => {
      await axios.delete(
        `/v1/admin/users/${data.userId}/identity-invites/${data.providerId}`
      );
    },
    onSuccess: async (_, variables) => {
      await invalidate(variables.userId);
      toast.success("Invite withdrawn");
    },
    onError: (error) => {
      toast.error(identityErrorMessage(error, "Failed to withdraw the invite"));
    },
  });

  return { invite, revoke };
};

export default useUserIdentityInvite;
