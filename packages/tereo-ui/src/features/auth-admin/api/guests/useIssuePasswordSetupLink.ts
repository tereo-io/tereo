import { passwordLinkErrorMessage } from "./guestErrors";
import { useMutation } from "@tanstack/react-query";
import type { PasswordSetupLink } from "./types";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";

const useIssuePasswordSetupLink = () => {
  const axios = useAxios("auth");

  return useMutation({
    mutationFn: async (data: {
      id: string;
      notify: boolean;
    }): Promise<PasswordSetupLink> => {
      const res = await axios.post(
        `/v1/admin/guests/${data.id}/password-setup-link`,
        { notify: data.notify }
      );
      return res.data;
    },
    onError: (error) => {
      toast.error(passwordLinkErrorMessage(error));
    },
  });
};

export default useIssuePasswordSetupLink;
