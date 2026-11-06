import useAllOrganizations from "../../api/organizations/useAllOrganizations";
import SendPasswordLinkButton from "../users/buttons/SendPasswordLinkButton";
import InviteGuestModal from "../organizations/modals/InviteGuestModal";
import useInfiniteGuests from "../../api/guests/useInfiniteGuests";
import ExtendGuestButton from "../users/buttons/ExtendGuestButton";
import { UserStatusBadge } from "../users/UserStatusBadge";
import { Link, useNavigate } from "react-router-dom";
import type { User } from "../../api/users/types";
import { formatDate } from "@/utils/formatDate";
import { useMemo, useState } from "react";
import { useAuth } from "@/lib/auth";
import {
  InfiniteScroll,
  Page,
  Row,
  TableCellLink,
  type InfiniteScrollMenu,
  type TableColumn,
} from "@kosmeo-ui/react";

/**
 * Guests through the guest endpoints (users.guests.read), for guest managers
 * without users.read; core lists only the organizations they act in.
 */
export const GuestList = () => {
  const navigate = useNavigate();
  const { hasPermission, organizations } = useAuth();
  const { data, hasMore, isLoading, onQueryChange, reload } =
    useInfiniteGuests();
  const [showInvite, setShowInvite] = useState(false);

  const canReadUsers = hasPermission("users.read");
  const canWriteGuests = hasPermission("users.guests.write");
  // Core gives a guest who has set a password a new link only under
  // users.write.
  const canWriteUsers = hasPermission("users.write");
  // organizations.write invites into any organization; everyone else only
  // into one they belong to.
  const anyOrganization =
    hasPermission("organizations.write") && hasPermission("organizations.read");
  const { data: allOrganizations } = useAllOrganizations({
    enabled: canWriteGuests && anyOrganization,
  });
  const inviteInto = anyOrganization
    ? (allOrganizations ?? [])
    : organizations.map(({ id, name }) => ({ id, name }));
  const canInvite =
    canWriteGuests && (anyOrganization || inviteInto.length > 0);

  const columns: TableColumn<User>[] = useMemo(
    () => [
      {
        title: "Email",
        dataKey: "email",
        cellElement: (user) =>
          canReadUsers ? (
            <TableCellLink as={Link} to={`/auth-admin/users/${user.id}`}>
              {user.email}
            </TableCellLink>
          ) : (
            user.email
          ),
      },
      {
        title: "Name",
        dataKey: "name",
        cellElement: (user) => user.name || "-",
      },
      {
        title: "Expires",
        dataKey: "expiresAt",
        cellElement: (user) =>
          user.expiresAt ? formatDate(user.expiresAt) : "-",
      },
      {
        title: "Status",
        dataKey: "status",
        width: "7rem",
        align: "center",
        cellElement: (user) => <UserStatusBadge user={user} />,
      },
      ...(canWriteGuests
        ? [
            {
              title: "Actions",
              width: "16rem",
              cellElement: (user: User) => (
                // Keeps clicks, the modals' included, off the row.
                <div onClick={(e) => e.stopPropagation()}>
                  <Row size="sm">
                    <ExtendGuestButton user={user} />
                    {(!user.hasPassword || canWriteUsers) && (
                      <SendPasswordLinkButton user={user} />
                    )}
                  </Row>
                </div>
              ),
            },
          ]
        : []),
    ],
    [canReadUsers, canWriteGuests, canWriteUsers]
  );

  const menu: InfiniteScrollMenu = useMemo(
    () => ({
      title: "Guests",
      titleAs: "h1",
      filters: [
        { type: "SEARCH", title: "Email", dataKey: "email" },
        {
          type: "SELECT",
          title: "Deactivated",
          dataKey: "isActive",
          options: [
            { id: "false", name: "Yes", selected: false },
            { id: "true", name: "No", selected: false },
          ],
        },
      ],
      sort: {
        sortDataKeys: [
          { dataKey: "email", displayName: "Email", selected: false },
          { dataKey: "createdAt", displayName: "Created", selected: false },
          { dataKey: "expiresAt", displayName: "Expires", selected: true },
        ],
        sortDirection: "asc",
      },
    }),
    []
  );

  return (
    <Page fillHeight maxWidth="none">
      <InfiniteScroll<User>
        menu={menu}
        data={data}
        hasMore={hasMore}
        isLoading={isLoading}
        onQueryChange={onQueryChange}
        columns={columns}
        onReload={reload}
        onAddNew={canInvite ? () => setShowInvite(true) : undefined}
        onRowClick={
          canReadUsers
            ? (u) => navigate(`/auth-admin/users/${u.id}`)
            : undefined
        }
        hideSelectColumn
      />
      <InviteGuestModal
        organizations={inviteInto}
        show={showInvite}
        onClose={() => setShowInvite(false)}
      />
    </Page>
  );
};
