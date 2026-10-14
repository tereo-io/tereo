import useCreateRole from "@/features/auth-admin/api/roles/useCreateRole";
import { CreateRoleInput } from "@/features/auth-admin/api/roles/types";
import { Button, Modal } from "@kosmeo-ui/react";
import { RoleForm } from "../forms/RoleForm";

interface CreateRoleModalProps {
  show: boolean;
  onCreate: () => void;
  onClose: () => void;
}

const CreateRoleModal = (props: CreateRoleModalProps) => {
  const createMutation = useCreateRole();

  const handleCreate = (data: CreateRoleInput) => {
    createMutation.mutate(data, { onSuccess: () => props.onCreate() });
  };

  return (
    <Modal
      show={props.show}
      onClose={props.onClose}
      title="Create Role"
      footerButtons={[
        <Button key="cancel" variant="secondary" onClick={props.onClose}>
          Cancel
        </Button>,
        <Button
          key="submit"
          type="submit"
          form="create-role-form"
          isLoading={createMutation.isPending}
        >
          Create Role
        </Button>,
      ]}
    >
      <RoleForm
        formId="create-role-form"
        onSubmit={(data) => handleCreate(data as CreateRoleInput)}
      />
    </Modal>
  );
};

export default CreateRoleModal;
