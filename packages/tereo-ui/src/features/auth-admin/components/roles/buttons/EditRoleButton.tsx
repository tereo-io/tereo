import { UpdateRoleInput, Role } from "@/features/auth-admin/api/roles/types";
import useUpdateRole from "@/features/auth-admin/api/roles/useUpdateRole";
import { Button, IconButton, Modal } from "@kosmeo-ui/react";
import { faEdit } from "@fortawesome/free-solid-svg-icons";
import { RoleForm } from "../forms/RoleForm";
import { useState } from "react";

interface EditRoleButtonProps {
  role: Role;
}

const EditRoleButton = ({ role }: EditRoleButtonProps) => {
  const [showEditModal, setShowEditModal] = useState(false);

  const updateMutation = useUpdateRole();

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
        onClose={() => setShowEditModal(false)}
        title="Edit Role"
        footerButtons={[
          <Button
            key="cancel"
            variant="secondary"
            onClick={() => setShowEditModal(false)}
          >
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
        />
      </Modal>
    </>
  );
};

export default EditRoleButton;
