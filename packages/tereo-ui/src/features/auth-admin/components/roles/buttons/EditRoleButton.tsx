import { UpdateRoleInput, Role } from "@/features/auth-admin/api/roles/types";
import useUpdateRole from "@/features/auth-admin/api/roles/useUpdateRole";
import { Button, IconButton, Modal } from "@kosmeo-ui/react";
import { RoleForm, roleFormErrors } from "../forms/RoleForm";
import { faEdit } from "@fortawesome/free-solid-svg-icons";
import { useState } from "react";

interface EditRoleButtonProps {
  role: Role;
}

const EditRoleButton = ({ role }: EditRoleButtonProps) => {
  const [showEditModal, setShowEditModal] = useState(false);

  const updateMutation = useUpdateRole();

  const { issues, error } = roleFormErrors(
    updateMutation.error,
    "Failed to update role"
  );

  const close = () => {
    updateMutation.reset();
    setShowEditModal(false);
  };

  const handleUpdate = (updateData: UpdateRoleInput) => {
    updateMutation.mutate(
      { id: role.id, updateData },
      { onSuccess: () => setShowEditModal(false) }
    );
  };

  return (
    <>
      <IconButton
        icon={faEdit}
        title="Edit"
        variant="secondary"
        size="sm"
        onClick={() => setShowEditModal(true)}
      />
      <Modal
        show={showEditModal}
        onClose={close}
        title="Edit Role"
        footerButtons={[
          <Button key="cancel" variant="secondary" onClick={close}>
            Cancel
          </Button>,
          <Button
            key="submit"
            type="submit"
            form="edit-role-form"
            isLoading={updateMutation.isPending}
          >
            Update Role
          </Button>,
        ]}
      >
        <RoleForm
          formId="edit-role-form"
          role={role}
          onSubmit={(data) => handleUpdate(data as UpdateRoleInput)}
          issues={issues}
          error={error}
        />
      </Modal>
    </>
  );
};

export default EditRoleButton;
