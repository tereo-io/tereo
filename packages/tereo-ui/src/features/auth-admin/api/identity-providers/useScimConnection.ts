import { useQuery } from "@tanstack/react-query";
import type { ScimConnection } from "./types";
import { useAxios } from "@/lib/auth";
import { isAxiosError } from "axios";

/** The provider's SCIM connection, or null while it has none. */
const useScimConnection = (providerId: string) => {
  const axios = useAxios("auth");

  return useQuery({
    queryKey: ["identity-providers", providerId, "scim"],
    queryFn: async (): Promise<ScimConnection | null> => {
      try {
        const res = await axios.get(
          `/v1/admin/identity-providers/${providerId}/scim`
        );
        return res.data;
      } catch (error) {
        if (isAxiosError(error) && error.response?.status === 404) return null;
        throw error;
      }
    },
    enabled: !!providerId,
  });
};

export default useScimConnection;
