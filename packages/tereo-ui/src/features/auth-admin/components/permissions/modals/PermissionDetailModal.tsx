import { Badge, Button, ListCard, Modal } from "@kosmeo-ui/react";
import type { Permission } from "../../../api/permissions/types";

interface PermissionDetailModalProps {
  permission: Permission | null;
  show: boolean;
  onClose: () => void;
}

// Permissions are declared in code by their services, so this is read-only:
// to change one, change the owning service's declaration.
const PermissionDetailModal = ({
  permission,
  show,
  onClose,
}: PermissionDetailModalProps) => (
  <Modal
    show={show}
    onClose={onClose}
    title={permission?.displayName ?? "Permission"}
    footerButtons={[
      <Button key="close" variant="secondary" onClick={onClose}>
        Close
      </Button>,
    ]}
  >
    {permission && (
      <ListCard
        listTitle="Permission Details"
        items={[
          {
            label: "Name",
            value: <span className="v-mono">{permission.name}</span>,
          },
          { label: "Display Name", value: permission.displayName },
          { label: "Description", value: permission.description || "-" },
          {
            label: "Declared By",
            value: permission.serviceName,
          },
          {
            label: "Status",
            value: <PermissionStatusBadge permission={permission} />,
          },
          {
            label: "Org-assignable",
            value: (
              <>
                <OrgAssignableBadge permission={permission} />{" "}
                {permission.orgAssignable
                  ? "Granted by a role assigned within an organization too"
                  : "Granted only by a global role"}
              </>
            ),
          },
          ...(permission.missingSince && !permission.retiredAt
            ? [
                {
                  label: "Missing Since",
                  value: new Date(permission.missingSince).toLocaleString(),
                },
              ]
            : []),
          ...(permission.retiredAt
            ? [
                {
                  label: "Retired",
                  value: new Date(permission.retiredAt).toLocaleString(),
                },
              ]
            : []),
          {
            label: "Registered",
            value: new Date(permission.createdAt).toLocaleString(),
          },
        ]}
      />
    )}
  </Modal>
);

export const OrgAssignableBadge = ({
  permission,
}: {
  permission: Pick<Permission, "orgAssignable">;
}) =>
  permission.orgAssignable ? (
    <Badge size="sm" subtle={true} variant="primary">
      Org
    </Badge>
  ) : (
    <Badge size="sm" subtle={true} variant="secondary">
      Global
    </Badge>
  );

export const PermissionStatusBadge = ({
  permission,
}: {
  permission: Permission;
}) => {
  if (permission.retiredAt) {
    return (
      <Badge size="sm" subtle={true} variant="danger">
        Retired
      </Badge>
    );
  }
  if (permission.missingSince) {
    return (
      <Badge size="sm" subtle={true} variant="warning">
        Missing
      </Badge>
    );
  }
  return (
    <Badge size="sm" subtle={true} variant="success">
      Active
    </Badge>
  );
};

export default PermissionDetailModal;
