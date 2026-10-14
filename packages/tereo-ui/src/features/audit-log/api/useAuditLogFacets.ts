import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { AuditLogFacets } from "../types";
import { useAuth, useAxios } from "@/lib/auth";

/**
 * `GET /v1/audit/entries/facets` — the sources, entity types and recent
 * metadata keys present in the entries the caller can read, under the same
 * organization filter as the list.
 */
const useAuditLogFacets = (organizationFilter?: string | null) => {
  const { hasPermission, currentOrganization } = useAuth();
  const axios = useAxios("audit");

  return useQuery({
    queryKey: [
      "audit-log-facets",
      currentOrganization?.id ?? null,
      organizationFilter ?? null,
    ],
    queryFn: async (): Promise<AuditLogFacets> => {
      const res = await axios.get<AuditLogFacets>("/entries/facets", {
        params: organizationFilter
          ? { "filter[organizationId]": organizationFilter }
          : undefined,
      });
      return res.data;
    },
    enabled: hasPermission("audit-logs.read"),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
};

export default useAuditLogFacets;
