import useCreateRole from "@/features/auth-admin/api/roles/useCreateRole";
import { CreateRoleInput } from "@/features/auth-admin/api/roles/types";
import { RoleForm, roleFormErrors } from "../forms/RoleForm";
import { Button, Modal } from "@kosmeo-ui/react";

interface CreateRoleModalProps {
  show: boolean;
  onCreate: () => void;
  onClose: () => void;
}

const CreateRoleModal = (props: CreateRoleModalProps) => {
  const createMutation = useCreateRole();

  const { issues, error } = roleFormErrors(
    createMutation.error,
    "Failed to create role"
  );

  const handleCreate = (data: CreateRoleInput) => {
    createMutation.mutate(data, { onSuccess: () => props.onCreate() });
  };

  const close = () => {
    createMutation.reset();
    props.onClose();
  };

  return (
    <Modal
      show={props.show}
      onClose={close}
      title="Create Role"
      footerButtons={[
        <Button key="cancel" variant="secondary" onClick={close}>
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
        issues={issues}
        error={error}
      />
    </Modal>
  );
};

export default CreateRoleModal;
