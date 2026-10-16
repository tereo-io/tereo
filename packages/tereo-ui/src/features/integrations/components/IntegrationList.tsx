import useInfiniteIntegrations from "../api/useInfiniteIntegrations";
import CreateIntegrationModal from "./modals/CreateIntegrationModal";
import { IntegrationStatusBadge, ScopeBadge } from "./StatusBadges";
import { ProvisionedBadge } from "@/components/ProvisionedBadge";
import type { Integration } from "../api/types";
import { useNavigate } from "react-router-dom";
import { useMemo, useState } from "react";
import { useAuth } from "@/lib/auth";
import {
  InfiniteScroll,
  Page,
  type InfiniteScrollMenu,
  type TableColumn,
} from "@kosmeo-ui/react";

export const IntegrationList = () => {
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const { data, hasMore, isLoading, onQueryChange, reload } =
    useInfiniteIntegrations();
  const [showCreateModal, setShowCreateModal] = useState(false);

  const columns: TableColumn<Integration>[] = useMemo(
    () => [
      {
        title: "Name",
        dataKey: "name",
        cellElement: (i) => (
          <span>
            {i.name}
            {i.provisioned && (
              <>
                {" "}
                <ProvisionedBadge />
              </>
            )}
          </span>
        ),
      },
      {
        title: "Slug",
        dataKey: "slug",
        cellElement: (i) => <span className="v-mono">{i.slug}</span>,
      },
      {
        title: "Organization",
        dataKey: "organizationId",
        cellElement: (i) =>
          i.organization ? (
            <span>
              {i.organization.name} <ScopeBadge bound />
            </span>
          ) : (
            <ScopeBadge bound={false} />
          ),
      },
      {
        title: "Status",
        dataKey: "isActive",
        width: "7rem",
        align: "center",
        cellElement: (i) => <IntegrationStatusBadge isActive={i.isActive} />,
      },
    ],
    []
  );

  const menu: InfiniteScrollMenu = useMemo(
    () => ({
      title: "Integrations",
      filters: [
        { type: "SEARCH", title: "Name", dataKey: "name" },
        { type: "SEARCH", title: "Slug", dataKey: "slug" },
      ],
      sort: {
        sortDataKeys: [
          { dataKey: "name", displayName: "Name", selected: true },
          { dataKey: "slug", displayName: "Slug", selected: false },
          { dataKey: "createdAt", displayName: "Created", selected: false },
        ],
        sortDirection: "asc",
      },
    }),
    []
  );

  return (
    <Page fillHeight maxWidth="none">
      <InfiniteScroll<Integration>
        menu={menu}
        data={data}
        hasMore={hasMore}
        isLoading={isLoading}
        onQueryChange={onQueryChange}
        columns={columns}
        onReload={reload}
        onAddNew={
          hasPermission("integrations.write")
            ? () => setShowCreateModal(true)
            : undefined
        }
        onRowClick={(i) => navigate(`/integrations/${i.id}`)}
        hideSelectColumn
      />
      <CreateIntegrationModal
        show={showCreateModal}
        onClose={() => setShowCreateModal(false)}
      />
    </Page>
  );
};
