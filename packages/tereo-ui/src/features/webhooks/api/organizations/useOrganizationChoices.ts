import fetchAllPages from "@/utils/fetchAllPages";
import { useQuery } from "@tanstack/react-query";
import { useAuth, useAxios } from "@/lib/auth";
import { useMemo } from "react";

export interface OrganizationChoice {
  id: string;
  name: string;
}

/**
 * Organizations a webhooks.admin can switch to: their memberships, plus every
 * organization when they also hold `organizations.read`.
 */
const useOrganizationChoices = () => {
  const { hasPermission, organizations } = useAuth();
  const axios = useAxios("auth");

  const canListAll =
    hasPermission("webhooks.admin") && hasPermission("organizations.read");

  const all = useQuery({
    queryKey: ["webhooks-organization-choices"],
    queryFn: () =>
      fetchAllPages<OrganizationChoice>(axios, "/v1/admin/organizations"),
    enabled: canListAll,
    staleTime: 60_000,
  });

  const choices = useMemo(() => {
    const byId = new Map<string, OrganizationChoice>();
    for (const { id, name } of [...organizations, ...(all.data ?? [])]) {
      byId.set(id, { id, name });
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [organizations, all.data]);

  return { choices, isLoading: canListAll && all.isLoading };
};

export default useOrganizationChoices;
