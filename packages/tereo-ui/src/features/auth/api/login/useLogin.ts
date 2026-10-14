import { useMutation } from "@tanstack/react-query";
import { usePublicAxios } from "@/lib/auth";
import { redirectTo } from "../redirectTo";

interface LoginParams {
  email: string;
  password: string;
  /** The authorize request's parameters, as core put them on /login. */
  oauthParams: Record<string, string>;
}

interface LoginResponse {
  redirect_url?: string;
}

const useLogin = () => {
  const axios = usePublicAxios("auth");
  return useMutation({
    mutationFn: async ({
      email,
      password,
      oauthParams,
    }: LoginParams): Promise<LoginResponse> => {
      const res = await axios.post<LoginResponse>(
        `/oauth/authorize`,
        new URLSearchParams({ ...oauthParams, email, password }),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          withCredentials: true,
        }
      );
      return res.data;
    },
    onSuccess: (data) => {
      if (data.redirect_url) redirectTo(data.redirect_url);
    },
  });
};

export default useLogin;
