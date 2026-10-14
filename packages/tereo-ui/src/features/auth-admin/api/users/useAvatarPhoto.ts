import { useQuery } from "@tanstack/react-query";
import { useAxios } from "@/lib/auth";

interface AccountProfile {
  photoUrl: string | null;
}

/**
 * Returns the user's presigned profile-photo URL. Uses the same
 * `["account","profile"]` query key as the auth-admin's `useAccountProfile`
 * so React Query dedupes concurrent fetches across the top-bar avatar and
 * the account page.
 */
const useAvatarPhoto = (): string | null => {
  const axios = useAxios("auth");

  const { data } = useQuery({
    queryKey: ["account", "profile"],
    queryFn: async (): Promise<AccountProfile> => {
      const res = await axios.get("/v1/account/me");
      return res.data;
    },
  });

  return data?.photoUrl ?? null;
};

export default useAvatarPhoto;
