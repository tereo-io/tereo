import { useQuery } from "@tanstack/react-query";
import { useAxios } from "@/lib/auth";

export interface UserTotpStatus {
  userId: string;
  totpEnabled: boolean;
  totpEnabledAt: string | null;
  totpRequired: boolean;
  recoveryCodesRemaining: number;
}

const useUserTotpStatus = (userId: string) => {
  const axios = useAxios("auth");

  const queryFn = async (): Promise<UserTotpStatus> => {
    const res = await axios.get(`/v1/admin/users/${userId}/totp`);
    return res.data;
  };

  return useQuery({
    queryKey: ["users", userId, "totp"],
    queryFn,
    enabled: !!userId,
  });
};

export default useUserTotpStatus;
