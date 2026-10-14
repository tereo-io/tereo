import { useQuery } from "@tanstack/react-query";
import type { UserSession } from "./types";
import { useAxios } from "@/lib/auth";

const useUserSessions = (userId: string) => {
  const axios = useAxios("auth");

  const queryFn = async (): Promise<{
    userId: string;
    sessions: UserSession[];
  }> => {
    const res = await axios.get(`/v1/admin/users/${userId}/sessions`);
    return res.data;
  };

  return useQuery({
    queryKey: ["users", userId, "sessions"],
    queryFn,
    enabled: !!userId,
  });
};

export default useUserSessions;
