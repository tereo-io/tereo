import type { OrgSelectSubmitParams, OrgSelectSubmitResponse } from "./types";
import { useMutation } from "@tanstack/react-query";
import { usePublicAxios } from "@/lib/auth";
import { redirectTo } from "../redirectTo";

const useSubmitOrgSelect = () => {
  const axios = usePublicAxios("auth");
  return useMutation({
    mutationFn: async (
      params: OrgSelectSubmitParams
    ): Promise<OrgSelectSubmitResponse> => {
      const res = await axios.post(`/oauth/org-select/submit`, params, {
        withCredentials: true,
      });
      return res.data;
    },
    onSuccess: (data) => {
      if (data.redirect_url) redirectTo(data.redirect_url);
    },
  });
};

export default useSubmitOrgSelect;
