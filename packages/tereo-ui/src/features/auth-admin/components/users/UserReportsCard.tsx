import ChangeReportsToButton from "./buttons/ChangeReportsToButton";
import ClearReportsToButton from "./buttons/ClearReportsToButton";
import useUserReports from "../../api/users/useUserReports";
import type { UserDetail } from "../../api/users/types";
import { ListCard } from "@kosmeo-ui/react";
import { Link } from "react-router-dom";
import { useAuth } from "@/lib/auth";

export const UserReportsCard = ({ user }: { user: UserDetail }) => {
  const { hasPermission } = useAuth();
  const { data: reports } = useUserReports(user.id);
  const canChange =
    hasPermission("users.reports.write") &&
    user.userType !== "service_account" &&
    user.managedBy?.kind !== "system";
  const manager = user.reportsTo;

  const directReports = reports?.length ? (
    <ul>
      {reports.map((r) => (
        <li key={r.id}>
          <Link to={`/auth-admin/users/${r.id}`} className="v-link">
            {r.name || r.email}
          </Link>
          {!r.isActive && <span> (deactivated)</span>}
        </li>
      ))}
    </ul>
  ) : (
    "No one reports to this user"
  );

  return (
    <ListCard
      listTitle="Reporting line"
      items={[
        {
          label: "Reports to",
          value: manager ? (
            <>
              <Link to={`/auth-admin/users/${manager.id}`} className="v-link">
                {manager.name || manager.email}
              </Link>
              {!manager.isActive && <span> (deactivated)</span>}
            </>
          ) : (
            "Reports to no one"
          ),
        },
        {
          label: `Direct reports (${reports?.length ?? user.directReportCount})`,
          value: directReports,
        },
      ]}
      footerButtons={
        canChange ? (
          <>
            <ChangeReportsToButton user={user} />
            {manager && <ClearReportsToButton user={user} />}
          </>
        ) : null
      }
    />
  );
};
