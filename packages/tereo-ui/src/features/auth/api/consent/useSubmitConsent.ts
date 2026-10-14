import { useMutation } from "@tanstack/react-query";
import { usePublicAxios } from "@/lib/auth";
import { redirectTo } from "../redirectTo";

interface SubmitConsentParams {
  sessionToken: string;
  approved: boolean;
}

interface ConsentResponse {
  redirect_url: string;
}

const useSubmitConsent = () => {
  const axios = usePublicAxios("auth");
  const mutationFn = async (
    params: SubmitConsentParams
  ): Promise<ConsentResponse> => {
    const res = await axios.post<ConsentResponse>(
      `/oauth/consent`,
      new URLSearchParams({
        session_token: params.sessionToken,
        approved: params.approved.toString(),
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        withCredentials: true,
      }
    );
    return res.data;
  };

  return useMutation({
    mutationFn,
    onSuccess: (data) => {
      if (data.redirect_url) redirectTo(data.redirect_url);
    },
  });
};

export default useSubmitConsent;
