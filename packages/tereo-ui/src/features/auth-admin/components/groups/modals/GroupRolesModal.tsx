import useSetGroupRoles from "@/features/auth-admin/api/groups/useSetGroupRoles";
import { Button, CheckboxGroup, Modal, Spinner } from "@kosmeo-ui/react";
import type { GroupRole } from "@/features/auth-admin/api/groups/types";
import useAllRoles from "@/features/auth-admin/api/roles/useAllRoles";
import { useState } from "react";

interface GroupRolesModalProps {
  groupId: string;
  /** An organization's group holds custom roles only. */
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
  const { data, isLoading } = useAllRoles();
  const mutation = useSetGroupRoles(groupId);

  // Core lists only unarchived, unretired roles, and refuses the rest.
  const assignable = (data ?? []).filter(
    (role) => role.isActive && (!organizational || !role.isSystem)
  );

  const save = () => {
    const ids = new Set(assignable.map((r) => r.id));
    mutation.mutate(
      selected.filter((id) => ids.has(id)),
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
        <Button key="save" onClick={save} isLoading={mutation.isPending}>
          Save Roles
        </Button>,
      ]}
    >
      {isLoading ? (
        <Spinner size="md" />
      ) : (
        <CheckboxGroup
          name="group-roles"
          options={assignable.map((role) => ({
            value: role.id,
            label: role.isSystem
              ? `${role.displayName} (system)`
              : role.displayName,
          }))}
          values={selected}
          onChange={setSelected}
        />
      )}
    </Modal>
  );
};

export default GroupRolesModal;
