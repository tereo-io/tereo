import { orgAssignableRoles } from "@/features/auth-admin/api/roles/orgAssignable";
import useSetGroupRoles from "@/features/auth-admin/api/groups/useSetGroupRoles";
import type { GroupRole } from "@/features/auth-admin/api/groups/types";
import useAllRoles from "@/features/auth-admin/api/roles/useAllRoles";
import { errorDescriptionOf } from "@/utils/apiErrors";
import { useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  CheckboxGroup,
  Modal,
  Spinner,
} from "@kosmeo-ui/react";

interface GroupRolesModalProps {
  groupId: string;
  /** An organization's group holds custom, org-assignable roles only. */
  organizational: boolean;
  currentRoles: GroupRole[];
  show: boolean;
  onClose: () => void;
}

const GroupRolesModal = ({
  groupId,
  organizational,
  currentRoles,
  show,
  onClose,
}: GroupRolesModalProps) => {
  const [selected, setSelected] = useState<string[]>(
    currentRoles.map((r) => r.id)
  );
  const { data, isLoading, isError, error } = useAllRoles();
  const mutation = useSetGroupRoles(groupId);

  // Core lists only unarchived, unretired roles. A held role outside that
  // set can't be picked again, but the PUT replaces the whole set, so it is
  // sent back as it is (shown checked and locked) rather than removed.
  const assignable = organizational
    ? orgAssignableRoles(data ?? [], new Set(currentRoles.map((r) => r.id)))
    : (data ?? []).filter((role) => role.isActive);
  const assignableIds = new Set(assignable.map((r) => r.id));
  const locked = currentRoles.filter((r) => !assignableIds.has(r.id));

  const save = () => {
    mutation.mutate(
      [
        ...selected.filter((id) => assignableIds.has(id)),
        ...locked.map((r) => r.id),
      ],
      { onSuccess: onClose }
    );
  };

  return (
    <Modal
      show={show}
      onClose={onClose}
      title="Edit Group Roles"
      size="lg"
      footerButtons={[
        <Button key="cancel" variant="secondary" onClick={onClose}>
          Cancel
        </Button>,
        <Button
          key="save"
          onClick={save}
          isLoading={mutation.isPending}
          disabled={isLoading || isError}
        >
          Save Roles
        </Button>,
      ]}
    >
      {isLoading ? (
        <Spinner size="md" />
      ) : isError ? (
        <Alert variant="danger">
          {errorDescriptionOf(error, "Could not load the roles")}
        </Alert>
      ) : (
        <>
          <CheckboxGroup
            name="group-roles"
            options={assignable.map((role) => ({
              value: role.id,
              label: role.isSystem
                ? `${role.displayName} (system)`
                : role.displayName,
            }))}
            values={selected.filter((id) => assignableIds.has(id))}
            onChange={setSelected}
          />
          {locked.map((role) => (
            <Checkbox
              key={role.id}
              labelLocation="right"
              label={`${role.displayName} (archived or inactive)`}
              checked
              disabled
              onChange={() => undefined}
            />
          ))}
        </>
      )}
    </Modal>
  );
};

export default GroupRolesModal;
