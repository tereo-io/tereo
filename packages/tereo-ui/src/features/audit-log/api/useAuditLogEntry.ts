import { useQuery } from "@tanstack/react-query";
import { useAuth, useAxios } from "@/lib/auth";
import type { AuditLogEntry } from "../types";

/**
 * `GET /v1/audit/entries/:id` — one entry. 404 outside the caller's org, or
 * outside `organizationFilter` (an org id or `none`, audit-logs.admin only).
 */
const useAuditLogEntry = (
  id: string | null | undefined,
  organizationFilter?: string | null
) => {
  const { hasPermission, currentOrganization } = useAuth();
  const axios = useAxios("audit");

  return useQuery({
    queryKey: [
      "audit-log-entry",
      currentOrganization?.id ?? null,
      organizationFilter ?? null,
      id,
    ],
    queryFn: async (): Promise<AuditLogEntry> => {
      const res = await axios.get<AuditLogEntry>(
        `/entries/${encodeURIComponent(id!)}`,
        {
          params: organizationFilter
            ? { "filter[organizationId]": organizationFilter }
            : undefined,
        }
      );
      return res.data;
    },
    enabled: !!id && hasPermission("audit-logs.read"),
    retry: false,
  });
};

export default useAuditLogEntry;
