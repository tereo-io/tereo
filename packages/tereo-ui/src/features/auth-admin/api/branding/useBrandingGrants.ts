import { useQuery } from "@tanstack/react-query";
import { useAxios } from "@/lib/auth";

export interface BrandingGrant {
  userId: string;
  email: string;
  name: string | null;
  grantedBy: string;
  grantedAt: string;
}

const useBrandingGrants = (clientId: string) => {
  const axios = useAxios("auth");

  const queryFn = async (): Promise<BrandingGrant[]> => {
    const res = await axios.get(
      `/v1/admin/branding/clients/${clientId}/grants`
    );
    return res.data.data;
  };

  return useQuery({ queryKey: ["branding", "grants", clientId], queryFn });
};

export default useBrandingGrants;
