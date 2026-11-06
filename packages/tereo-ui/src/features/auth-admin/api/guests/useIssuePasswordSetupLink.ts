import { useMutation } from "@tanstack/react-query";
import type { PasswordSetupLink } from "./types";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

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
    onError: (error: AxiosError<{ error_description?: string }>) => {
      toast.error(
        error.response?.data?.error_description ||
          "Failed to create the password link"
      );
    },
  });
};

export default useIssuePasswordSetupLink;
