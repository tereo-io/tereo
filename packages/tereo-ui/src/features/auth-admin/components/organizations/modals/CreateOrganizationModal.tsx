import useCreateOrganization from "@/features/auth-admin/api/organizations/useCreateOrganization";
import type { CreateOrganizationInput } from "@/features/auth-admin/api/organizations/types";
import { OrganizationForm } from "../forms/OrganizationForm";
import { Button, Modal } from "@kosmeo-ui/react";

interface CreateOrganizationModalProps {
  show: boolean;
  onCreate: () => void;
  onClose: () => void;
}

const CreateOrganizationModal = (props: CreateOrganizationModalProps) => {
  const createMutation = useCreateOrganization();

  const handleCreate = (data: CreateOrganizationInput) => {
    createMutation.mutate(data, { onSuccess: () => props.onCreate() });
  };

  return (
    <Modal
      show={props.show}
      onClose={props.onClose}
      title="Create Organization"
      footerButtons={[
        <Button key="cancel" variant="secondary" onClick={props.onClose}>
          Cancel
        </Button>,
        <Button
          key="submit"
          type="submit"
          form="create-organization-form"
          isLoading={createMutation.isPending}
        >
          Create Organization
        </Button>,
      ]}
    >
      <OrganizationForm
        formId="create-organization-form"
        onSubmit={(data) => handleCreate(data as CreateOrganizationInput)}
      />
    </Modal>
  );
};

export default CreateOrganizationModal;
