import type { BrandingList, BrandingListEntry } from "./types";
import { useQuery } from "@tanstack/react-query";
import { useAxios } from "@/lib/auth";

const useBrandingList = ({ enabled = true }: { enabled?: boolean } = {}) => {
  const axios = useAxios("auth");

  const queryFn = async (): Promise<BrandingList> => {
    const res = await axios.get("/v1/admin/branding");
    const body = res.data ?? {};
    const clients: BrandingListEntry[] = body.clients ?? body.data ?? [];
    return {
      default: body.default ?? null,
      clients,
      brandable: body.brandable ?? [],
    };
  };

  return useQuery({ queryKey: ["branding", "list"], queryFn, enabled });
};

export default useBrandingList;
