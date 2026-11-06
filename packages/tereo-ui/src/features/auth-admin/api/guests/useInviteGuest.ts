import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { InviteGuestInput, InviteGuestResult } from "./types";
import { useAxios } from "@/lib/auth";

/** Errors are left to the caller: the modal words each 409 itself. */
const useInviteGuest = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  return useMutation({
    mutationFn: async (input: InviteGuestInput): Promise<InviteGuestResult> => {
      const res = await axios.post("/v1/admin/guests", input);
      return res.data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["users"] });
      await queryClient.invalidateQueries({ queryKey: ["organizations"] });
    },
  });
};

export default useInviteGuest;
