import { useQuery } from "@tanstack/react-query";
import type { SystemSettings } from "./types";
import { useAxios } from "@/lib/auth";

const useSettings = () => {
  const axios = useAxios("auth");

  const queryFn = async (): Promise<SystemSettings> => {
    const res = await axios.get("/v1/admin/settings");
    return res.data;
  };

  return useQuery({
    queryKey: ["settings"],
    queryFn,
  });
};

export default useSettings;
