import { useInfiniteCursor } from "@kosmeo-ui/react";
import type { User } from "../users/types";
import { useAxios } from "@/lib/auth";

/** A guest as `GET /v1/admin/guests` lists it. */
export type GuestRow = User & { organizationId: string | null };

/** Guests in the organizations the viewer may manage them in (users.guests.read). */
const useInfiniteGuests = () => {
  const axios = useAxios("auth");
  return useInfiniteCursor<GuestRow>({
    axiosInstance: axios,
    endpoint: "/v1/admin/guests",
    queryKey: "guests",
  });
};

export default useInfiniteGuests;
