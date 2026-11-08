import { targetPath, type BrandingProfile, type BrandingTarget } from "./types";
import { useQuery } from "@tanstack/react-query";
import { useAxios } from "@/lib/auth";

const useBrandingProfile = (target: BrandingTarget) => {
  const axios = useAxios("auth");

  const queryFn = async (): Promise<BrandingProfile> => {
    const res = await axios.get(targetPath(target));
    return res.data;
  };

  return useQuery({
    queryKey: [
      "branding",
      "profile",
      target.kind === "default" ? "default" : target.id,
    ],
    queryFn,
  });
};

export default useBrandingProfile;
