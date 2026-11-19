import { useQuery } from "@tanstack/react-query";
import type { UserReport } from "./types";
import { useAxios } from "@/lib/auth";

/** Direct reports only; the transitive read is for services. */
const useUserReports = (userId: string) => {
  const axios = useAxios("auth");

  const queryFn = async (): Promise<UserReport[]> => {
    const res = await axios.get(`/v1/admin/users/${userId}/reports`, {
      params: { transitive: false },
    });
    return res.data.data;
  };

  return useQuery({
    queryKey: ["users", userId, "reports"],
    queryFn,
    enabled: !!userId,
  });
};

export default useUserReports;
