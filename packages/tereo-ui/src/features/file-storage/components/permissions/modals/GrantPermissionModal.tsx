import useGrantPermission from "@/features/file-storage/api/permissions/useGrantPermission";
import type { GrantPermissionInput } from "@/features/file-storage/api/permissions/types";
import { useMemo, useState } from "react";
import { useAuth } from "@/lib/auth";
import {
  UserTypeahead,
  useOrganizationMembers,
  type UserListItem,
} from "@/features/auth-admin";
import {
  Button,
  CheckboxGroup,
  Col,
  FormError,
  Input,
  Modal,
  Typeahead,
} from "@kosmeo-ui/react";

const displayName = (user: Pick<UserListItem, "name" | "email">) =>
  `${user.name || "No Name"} (${user.email})`;

interface GrantPermissionModalProps {
  bucketName: string;
  /** The bucket's organization; null for a bucket in no organization. */
  organizationId: string | null;
  show: boolean;
  onGrant: () => void;
  onClose: () => void;
}

const GrantPermissionModal = ({
  bucketName,
  organizationId,
  show,
  onGrant,
  onClose,
}: GrantPermissionModalProps) => {
  const { hasPermission, currentOrganization } = useAuth();
  const { mutate: grantPermission, isPending } = useGrantPermission(bucketName);
  // Core grants an organization's bucket only to members of that
  // organization, so those are the only grantees offered.
  const orgId = organizationId ?? undefined;
  const { data: membersData } = useOrganizationMembers(
    orgId ?? "",
    show && !!orgId
  );
  const memberOptions = useMemo(
    () =>
      (membersData?.members ?? [])
        .filter((m) => m.user.isActive)
        .map((m) => ({ ...m.user, displayName: displayName(m.user) })),
    [membersData]
  );
  // Without an organization, any user: searching `/v1/admin/users` needs
  // `users.read`; without it, take the user id directly — core checks it.
  const canSearchUsers = hasPermission("users.read");
  const [selectedUser, setSelectedUser] = useState<UserListItem | null>(null);
  const [manualUserId, setManualUserId] = useState("");
  const [formData, setFormData] = useState<GrantPermissionInput>({
    userId: "",
    canRead: true,
    canWrite: false,
    canDelete: false,
  });
  const [userError, setUserError] = useState("");

  const picksUser = !!orgId || canSearchUsers;

  const handleSubmit = () => {
    const userId = picksUser ? selectedUser?.id : manualUserId.trim();
    if (!userId) {
      setUserError(
        picksUser ? "Please select a user" : "Please enter a user ID"
      );
      return;
    }

    grantPermission(
      { bucketName, data: { ...formData, userId } },
      {
        onSuccess: () => {
          setSelectedUser(null);
          setManualUserId("");
          setFormData({
            userId: "",
            canRead: true,
            canWrite: false,
            canDelete: false,
          });
          setUserError("");
          onGrant();
        },
      }
    );
  };

  const handleClose = () => {
    setSelectedUser(null);
    setManualUserId("");
    setFormData({
      userId: "",
      canRead: true,
      canWrite: false,
      canDelete: false,
    });
    setUserError("");
    onClose();
  };

  const handleUserSelect = (user: UserListItem | null) => {
    setSelectedUser(user);
    if (user) setUserError("");
  };

  return (
    <Modal
      show={show}
      onClose={handleClose}
      title={`Grant Permission on ${bucketName}`}
      footerButtons={[
        <Button
          key="grant"
          onClick={handleSubmit}
          isLoading={isPending}
          disabled={isPending}
        >
          Grant
        </Button>,
        <Button
          key="cancel"
          variant="secondary"
          onClick={handleClose}
          disabled={isPending}
        >
          Cancel
        </Button>,
      ]}
    >
      <Col>
        {orgId ? (
          <Typeahead
            label={
              currentOrganization?.id === orgId
                ? `Member of ${currentOrganization.name}`
                : "Member of the bucket's organization"
            }
            options={memberOptions}
            labelKey="displayName"
            onSelect={(option: (typeof memberOptions)[number] | null) =>
              handleUserSelect(option)
            }
            onFilterChange={() => {}}
            placeholder="Search by name or email"
            value={
              selectedUser
                ? { ...selectedUser, displayName: displayName(selectedUser) }
                : null
            }
            required
            showAll
          />
        ) : canSearchUsers ? (
          <UserTypeahead
            value={selectedUser}
            onSelect={handleUserSelect}
            required
          />
        ) : (
          <Input
            label="User ID"
            value={manualUserId}
            onChange={(e) => {
              setManualUserId(e.target.value);
              setUserError("");
            }}
            placeholder="User UUID"
            required
          />
        )}
        {userError && <FormError>{userError}</FormError>}

        <CheckboxGroup
          label="Permissions"
          name="permissions"
          options={[
            { value: "canRead", label: "Can Read" },
            { value: "canWrite", label: "Can Write" },
            { value: "canDelete", label: "Can Delete" },
          ]}
          values={[
            ...(formData.canRead ? ["canRead"] : []),
            ...(formData.canWrite ? ["canWrite"] : []),
            ...(formData.canDelete ? ["canDelete"] : []),
          ]}
          onChange={(values) =>
            setFormData({
              ...formData,
              canRead: values.includes("canRead"),
              canWrite: values.includes("canWrite"),
              canDelete: values.includes("canDelete"),
            })
          }
        />
      </Col>
    </Modal>
  );
};

export default GrantPermissionModal;
