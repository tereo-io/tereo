import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import useInfiniteEntityHistory from "../api/useInfiniteEntityHistory";
import EntityHistoryTable from "./EntityHistoryTable";
import { PageHeader } from "@/components/PageHeader";
import { auditLogHref } from "../utils/urlFilters";
import { formatEntityType } from "../utils/format";
import { Page } from "@kosmeo-ui/react";
import { useAuth } from "@/lib/auth";

/**
 * `/audit-log/entity/:entityType/:entityId` — one entity's full history,
 * from core's entity endpoint. `?organizationId=<id>|none` reads another
 * organization's or system-wide history (audit-logs.admin).
 */
export const EntityHistory = () => {
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const [searchParams] = useSearchParams();
  const { entityType = "", entityId = "" } = useParams<{
    entityType: string;
    entityId: string;
  }>();
  const organizationFilter = hasPermission("audit-logs.admin")
    ? searchParams.get("organizationId")
    : null;
  const history = useInfiniteEntityHistory(
    entityType,
    entityId,
    organizationFilter
  );

  if (!hasPermission("audit-logs.read")) return null;

  // Entries carry the entity's display name as of when each was written; the
  // newest loaded one is the best label available.
  const entityName = history.data.find((e) => e.entityName)?.entityName;

  return (
    <Page fillHeight maxWidth="none">
      <PageHeader
        title={entityName ?? entityId}
        subtitle={`${formatEntityType(entityType)} · ${entityId}`}
        actions={[
          {
            label: "Back to audit log",
            onClick: () => navigate("/audit-log/entries"),
          },
          {
            label: "Open as filter",
            onClick: () =>
              navigate(
                auditLogHref({
                  entityType,
                  entityId,
                  ...(organizationFilter && {
                    organizationId: organizationFilter,
                  }),
                })
              ),
          },
        ]}
      />
      <EntityHistoryTable
        history={history}
        title="History"
        organizationFilter={organizationFilter}
      />
    </Page>
  );
};
