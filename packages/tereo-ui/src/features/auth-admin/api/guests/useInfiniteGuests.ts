import { useInfiniteCursor } from "@kosmeo-ui/react";
import type { User } from "../users/types";
import { useAxios } from "@/lib/auth";

/** Guests in the organizations the viewer may manage them in (users.guests.read). */
const useInfiniteGuests = () => {
  const axios = useAxios("auth");
  return useInfiniteCursor<User>({
    axiosInstance: axios,
    endpoint: "/v1/admin/guests",
    queryKey: "guests",
  });
};

export default useInfiniteGuests;
