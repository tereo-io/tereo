import useInfiniteServiceAccess from "../api/useInfiniteServiceAccess";
import useDecideServiceAccess from "../api/useDecideServiceAccess";
import type { ServiceAccessListItem } from "../api/types";
import { AccessStatusBadge } from "./StatusBadges";
import { AccessDecision } from "./AccessDecision";
import { CORE_SERVICE_ID } from "../constants";
import { AccessTarget } from "./AccessTarget";
import { Link } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { useMemo } from "react";
import {
  Button,
  InfiniteScroll,
  Page,
  RowActions,
  type InfiniteScrollMenu,
  type TableColumn,
} from "@kosmeo-ui/react";

const KIND_LABEL = { role: "Role", audience: "Audience" } as const;

/**
 * Every service's access requests in one place, pending first by default —
 * the inbox an approver works through without opening each service.
 */
export const AccessRequestList = () => {
  const { hasPermission } = useAuth();
  const canDecide = hasPermission("services.approve");
  const { data, hasMore, isLoading, onQueryChange, reload } =
    useInfiniteServiceAccess();
  const approve = useDecideServiceAccess("approve");
  const revoke = useDecideServiceAccess("revoke");
  const busy = approve.isPending || revoke.isPending;

  const columns: TableColumn<ServiceAccessListItem>[] = useMemo(
    () => [
      {
        title: "Service",
        cellElement: (a) => (
          <Link className="v-link" to={`/services/${a.service.id}`}>
            {a.service.name}
          </Link>
        ),
      },
      {
        title: "Kind",
        dataKey: "kind",
        width: "7rem",
        cellElement: (a) => KIND_LABEL[a.kind],
      },
      {
        title: "Target",
        dataKey: "target",
        cellElement: (a) => <AccessTarget access={a} />,
      },
      {
        title: "Status",
        dataKey: "status",
        width: "7rem",
        cellElement: (a) => <AccessStatusBadge status={a.status} />,
      },
      {
        title: "Requested",
        dataKey: "requestedAt",
        cellElement: (a) => new Date(a.requestedAt).toLocaleString(),
      },
      {
        title: "Decided",
        dataKey: "decidedAt",
        cellElement: (a) => <AccessDecision access={a} />,
      },
      {
        title: "Actions",
        width: "12rem",
        align: "right",
        hidden: !canDecide,
        disableRowClick: true,
        cellElement: (a) =>
          a.service.id === CORE_SERVICE_ID ? null : (
            <RowActions align="end">
              {a.status !== "approved" && (
                <Button
                  size="sm"
                  variant="success"
                  disabled={busy}
                  onClick={() =>
                    approve.mutate({ serviceId: a.service.id, ids: [a.id] })
                  }
                >
                  Approve
                </Button>
              )}
              {a.status !== "revoked" && (
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy}
                  onClick={() =>
                    revoke.mutate({ serviceId: a.service.id, ids: [a.id] })
                  }
                >
                  {a.status === "pending" && !a.decidedAt ? "Deny" : "Revoke"}
                </Button>
              )}
            </RowActions>
          ),
      },
    ],
    [canDecide, busy, approve, revoke]
  );

  const menu: InfiniteScrollMenu = useMemo(
    () => ({
      title: "Access Requests",
      filters: [
        {
          type: "SELECT",
          title: "Status",
          dataKey: "status",
          multiSelect: true,
          options: [
            { id: "pending", name: "Pending", selected: true },
            { id: "approved", name: "Approved", selected: false },
            { id: "revoked", name: "Revoked", selected: false },
          ],
        },
        {
          type: "SELECT",
          title: "Kind",
          dataKey: "kind",
          options: [
            { id: "role", name: "Role", selected: false },
            { id: "audience", name: "Audience", selected: false },
          ],
        },
        { type: "SEARCH", title: "Target", dataKey: "target" },
      ],
      sort: {
        sortDataKeys: [
          { dataKey: "requestedAt", displayName: "Requested", selected: true },
        ],
        sortDirection: "desc",
      },
    }),
    []
  );

  return (
    <Page fillHeight maxWidth="none">
      <InfiniteScroll<ServiceAccessListItem>
        menu={menu}
        data={data}
        hasMore={hasMore}
        isLoading={isLoading}
        onQueryChange={onQueryChange}
        columns={columns}
        onReload={reload}
        hideSelectColumn
      />
    </Page>
  );
};
