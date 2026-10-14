import { UpdateUserInput, User } from "@/features/auth-admin/api/users/types";
import useUpdateUser from "@/features/auth-admin/api/users/useUpdateUser";
import { Button, IconButton, Modal } from "@kosmeo-ui/react";
import { faEdit } from "@fortawesome/free-solid-svg-icons";
import { UserForm } from "../forms/UserForm";
import { useState } from "react";

interface EditUserButtonProps {
  user: User;
}

const EditUserButton = ({ user }: EditUserButtonProps) => {
  const [showEditModal, setShowEditModal] = useState(false);

  const updateMutation = useUpdateUser();

  const handleUpdate = (updateData: UpdateUserInput) => {
    updateMutation.mutate(
      { id: user.id, updateData },
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
        title="Edit User"
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
            form="edit-user-form"
            isLoading={updateMutation.isPending}
          >
            Update User
          </Button>,
        ]}
      >
        <UserForm
          formId="edit-user-form"
          user={user}
          onSubmit={(data) => handleUpdate(data as UpdateUserInput)}
        />
      </Modal>
    </>
  );
};

export default EditUserButton;
