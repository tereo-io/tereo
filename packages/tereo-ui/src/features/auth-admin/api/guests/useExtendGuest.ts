import { useMutation, useQueryClient } from "@tanstack/react-query";
import { extendGuestErrorMessage } from "./guestErrors";
import type { UserDetail } from "../users/types";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";

const useExtendGuest = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  return useMutation({
    mutationFn: async (data: {
      id: string;
      expiresAt: string;
    }): Promise<UserDetail> => {
      const res = await axios.patch(`/v1/admin/guests/${data.id}`, {
        expiresAt: data.expiresAt,
      });
      return res.data;
    },
    onSuccess: async (_data, variables) => {
      await queryClient.invalidateQueries({
        queryKey: ["users", variables.id],
      });
      await queryClient.invalidateQueries({ queryKey: ["users"] });
      await queryClient.invalidateQueries({ queryKey: ["guests-infinite"] });
      toast.success("Guest access updated");
    },
    onError: (error) => {
      toast.error(extendGuestErrorMessage(error));
    },
  });
};

export default useExtendGuest;
