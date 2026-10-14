import { useLocalStorage } from "@kosmeo-ui/react";
import { useQuery } from "@tanstack/react-query";
import { useAxios } from "./axiosContext";
import { AxiosError } from "axios";
import env from "./config";

export interface UserOrganization {
  id: string;
  name: string;
  slug: string;
  memberRole: string;
}

export interface UserInfo {
  sub: string;
  email: string;
  name?: string;
  permissions?: string[];
  org_id?: string;
  org_name?: string;
  organizations?: UserOrganization[];
}

const useUserInfo = () => {
  const [token] = useLocalStorage(env.TOKEN_KEY, null);
  const axios = useAxios("auth");

  const queryFn = async () => {
    const res = await axios.get(`/oauth/userinfo`);
    return res.data as UserInfo;
  };

  return useQuery({
    queryKey: ["userInfo"],
    queryFn,
    enabled: token !== null,
    retry: (failureCount, error) => {
      // Don't retry on auth errors (401, 403)
      if (error instanceof AxiosError) {
        const status = error.response?.status;
        if (status === 401 || status === 403) return false;
      }
      // Retry up to 2 times for other errors (network issues, 5xx, etc.)
      return failureCount < 2;
    },
    retryDelay: (i) => Math.min(1000 * 2 ** i, 30000),
  });
};

export default useUserInfo;
