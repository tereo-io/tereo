import { useMutation, useQueryClient } from "@tanstack/react-query";
import { promoteGuestErrorMessage } from "./guestErrors";
import type { UserDetail } from "../users/types";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";

const usePromoteUser = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  return useMutation({
    mutationFn: async (id: string): Promise<UserDetail> => {
      const res = await axios.post(`/v1/admin/users/${id}/promote`);
      return res.data;
    },
    onSuccess: async (_data, id) => {
      await queryClient.invalidateQueries({ queryKey: ["users", id] });
      await queryClient.invalidateQueries({ queryKey: ["users"] });
      await queryClient.invalidateQueries({ queryKey: ["guests-infinite"] });
      toast.success("Guest promoted to a full user");
    },
    onError: (error) => {
      toast.error(promoteGuestErrorMessage(error));
    },
  });
};

export default usePromoteUser;
