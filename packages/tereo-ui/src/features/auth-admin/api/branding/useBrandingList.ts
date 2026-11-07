import type { BrandingList, BrandingListEntry } from "./types";
import { useQuery } from "@tanstack/react-query";
import { useAxios } from "@/lib/auth";

const useBrandingList = () => {
  const axios = useAxios("auth");

  const queryFn = async (): Promise<BrandingList> => {
    const res = await axios.get("/v1/admin/branding");
    const body = res.data ?? {};
    const clients: BrandingListEntry[] = body.clients ?? body.data ?? [];
    return { default: body.default ?? null, clients };
  };

  return useQuery({ queryKey: ["branding", "list"], queryFn });
};

export default useBrandingList;
