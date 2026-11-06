import { useQuery } from "@tanstack/react-query";
import type { GuestOptions } from "./types";
import { useAxios } from "@/lib/auth";

/** Needs users.guests.write; pass `enabled: false` until it is needed. */
const useGuestOptions = ({ enabled = true }: { enabled?: boolean } = {}) => {
  const axios = useAxios("auth");

  return useQuery({
    queryKey: ["guestOptions"],
    enabled,
    queryFn: async (): Promise<GuestOptions> => {
      const res = await axios.get("/v1/admin/guests/options");
      return res.data;
    },
  });
};

export default useGuestOptions;
