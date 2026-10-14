import { useQuery } from "@tanstack/react-query";
import { usePublicAxios } from "@/lib/auth";

export interface ConsentScope {
  name: string;
  description: string | null;
}

export interface ConsentDetails {
  sessionToken: string;
  clientName: string;
  clientId: string;
  scopes: ConsentScope[];
  user: {
    email: string;
    name: string | null;
  };
}

const useConsentDetails = (sessionToken: string | null) => {
  const axios = usePublicAxios("auth");
  const queryFn = async () => {
    if (!sessionToken) throw new Error("No session token provided");

    const res = await axios.get<ConsentDetails>(`/oauth/consent`, {
      params: { session: sessionToken },
      withCredentials: true,
    });

    return res.data;
  };
  return useQuery<ConsentDetails, Error>({
    queryKey: ["consent", sessionToken],
    queryFn,
    enabled: !!sessionToken,
    staleTime: 0,
  });
};

export default useConsentDetails;
