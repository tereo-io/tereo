import { useQuery } from "@tanstack/react-query";
import { usePublicAxios } from "@/lib/auth";

export interface LogoutRequest {
  clientId: string;
  confirmToken: string;
}

export interface LogoutDetails {
  client_name: string;
  /** Where the user signs in to the client again. */
  sign_in_url: string;
}

/** The client a sign-out confirmation is for; refused without its cookie. */
const useLogoutDetails = (request: LogoutRequest | null) => {
  const axios = usePublicAxios("auth");
  return useQuery<LogoutDetails, Error>({
    queryKey: ["logout-confirm", request?.clientId, request?.confirmToken],
    queryFn: async () => {
      const res = await axios.get<LogoutDetails>(`/oauth/end-session/confirm`, {
        params: {
          client_id: request!.clientId,
          confirm_token: request!.confirmToken,
        },
        withCredentials: true,
      });
      return res.data;
    },
    enabled: !!request,
    retry: false,
    staleTime: Infinity,
  });
};

export default useLogoutDetails;
