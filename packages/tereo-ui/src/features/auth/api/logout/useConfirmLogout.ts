import type { LogoutRequest } from "./useLogoutDetails";
import { useMutation } from "@tanstack/react-query";
import { usePublicAxios } from "@/lib/auth";

export interface ConfirmLogoutParams extends LogoutRequest {
  postLogoutRedirectUri?: string;
  state?: string;
}

export interface ConfirmLogoutResponse {
  /** The client's post-logout redirect, when it asked for one. */
  redirect_url: string | null;
  sign_in_url: string;
}

/** Ends this browser's session with the client; core checks the token. */
const useConfirmLogout = () => {
  const axios = usePublicAxios("auth");
  return useMutation({
    mutationFn: async (params: ConfirmLogoutParams) => {
      const res = await axios.post<ConfirmLogoutResponse>(
        `/oauth/end-session/confirm`,
        new URLSearchParams({
          client_id: params.clientId,
          confirm_token: params.confirmToken,
          ...(params.postLogoutRedirectUri && {
            post_logout_redirect_uri: params.postLogoutRedirectUri,
          }),
          ...(params.state && { state: params.state }),
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
    },
  });
};

export default useConfirmLogout;
