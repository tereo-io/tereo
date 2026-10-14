import { useMutation } from "@tanstack/react-query";
import { redirectTo } from "@/features/auth";
import { useAxios } from "@/lib/auth";

/** Starts linking a provider: core answers with where to send the browser. */
const useConnectIdentity = () => {
  const axios = useAxios("auth");

  return useMutation({
    mutationFn: async (provider: string): Promise<{ redirect_url: string }> => {
      // The response sets the upstream_auth cookie the callback checks; a
      // cross-origin UI (the dev server) only stores it with credentials.
      const res = await axios.post(
        "/v1/account/identities",
        { provider },
        { withCredentials: true }
      );
      return res.data;
    },
    onSuccess: (data) => redirectTo(data.redirect_url),
  });
};

export default useConnectIdentity;
