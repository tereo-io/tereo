import useCreateUser from "@/features/auth-admin/api/users/useCreateUser";
import { CreateUserInput } from "@/features/auth-admin/api/users/types";
import { Button, Modal } from "@kosmeo-ui/react";
import { UserForm } from "../forms/UserForm";

interface CreateUserModalProps {
  show: boolean;
  onCreate: () => void;
  onClose: () => void;
}

const CreateUserModal = (props: CreateUserModalProps) => {
  const createMutation = useCreateUser();

  const handleCreate = (data: CreateUserInput) => {
    createMutation.mutate(data, { onSuccess: () => props.onCreate() });
  };

  return (
    <Modal
      show={props.show}
      onClose={props.onClose}
      title="Create User"
      footerButtons={[
        <Button key="cancel" variant="secondary" onClick={props.onClose}>
          Cancel
        </Button>,
        <Button
          key="submit"
          type="submit"
          form="create-user-form"
          isLoading={createMutation.isPending}
        >
          Create User
        </Button>,
      ]}
    >
      <UserForm
        formId="create-user-form"
        onSubmit={(data) => handleCreate(data as CreateUserInput)}
      />
    </Modal>
  );
};

export default CreateUserModal;
