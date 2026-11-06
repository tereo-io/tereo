import type { User } from "../../api/users/types";
import { Badge } from "@kosmeo-ui/react";

export const userTypeLabel = (type: User["userType"]) =>
  type === "human" ? "Human" : type === "guest" ? "Guest" : "Service Account";

/** A guest past its expiry reads "Expired", apart from an admin's deactivation. */
export const UserStatusBadge = ({ user }: { user: User }) => {
  const status = user.status ?? (user.isActive ? "active" : "deactivated");
  return (
    <Badge
      size="sm"
      subtle={true}
      variant={
        status === "active"
          ? "success"
          : status === "expired"
            ? "warning"
            : "danger"
      }
    >
      {status === "active"
        ? "Active"
        : status === "expired"
          ? "Expired"
          : "Inactive"}
    </Badge>
  );
};
