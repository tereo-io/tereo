import useUpdateOrganization from "@/features/auth-admin/api/organizations/useUpdateOrganization";
import { Button, IconButton, Modal } from "@kosmeo-ui/react";
import { OrganizationForm } from "../forms/OrganizationForm";
import { faEdit } from "@fortawesome/free-solid-svg-icons";
import { useState } from "react";
import type {
  UpdateOrganizationInput,
  Organization,
} from "@/features/auth-admin/api/organizations/types";

interface EditOrganizationButtonProps {
  organization: Organization;
}

const EditOrganizationButton = ({
  organization,
}: EditOrganizationButtonProps) => {
  const [showEditModal, setShowEditModal] = useState(false);

  const updateMutation = useUpdateOrganization();

  const handleUpdate = (updateData: UpdateOrganizationInput) => {
    updateMutation.mutate(
      { id: organization.id, updateData },
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
        title="Edit Organization"
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
            form="edit-organization-form"
            isLoading={updateMutation.isPending}
          >
            Update Organization
          </Button>,
        ]}
      >
        <OrganizationForm
          formId="edit-organization-form"
          organization={organization}
          onSubmit={(data) => handleUpdate(data as UpdateOrganizationInput)}
        />
      </Modal>
    </>
  );
};

export default EditOrganizationButton;
