import { useQuery } from "@tanstack/react-query";
import type { SystemSettings } from "./types";
import { useAxios } from "@/lib/auth";

/** Pass `enabled: false` when the viewer lacks `settings.read`. */
const useSettings = ({ enabled = true }: { enabled?: boolean } = {}) => {
  const axios = useAxios("auth");

  const queryFn = async (): Promise<SystemSettings> => {
    const res = await axios.get("/v1/admin/settings");
    return res.data;
  };

  return useQuery({
    queryKey: ["settings"],
    enabled,
    queryFn,
  });
};

export default useSettings;
