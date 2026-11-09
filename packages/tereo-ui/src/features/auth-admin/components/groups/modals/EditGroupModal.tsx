import useUpdateGroup from "@/features/auth-admin/api/groups/useUpdateGroup";
import { GroupForm, groupFormErrors } from "../forms/GroupForm";
import { Button, Modal } from "@kosmeo-ui/react";
import type {
  Group,
  UpdateGroupInput,
} from "@/features/auth-admin/api/groups/types";

interface EditGroupModalProps {
  group: Group;
  show: boolean;
  onClose: () => void;
}

const EditGroupModal = ({ group, show, onClose }: EditGroupModalProps) => {
  const updateMutation = useUpdateGroup();

  const { issues, error } = groupFormErrors(
    updateMutation.error,
    "Failed to update group"
  );

  const close = () => {
    updateMutation.reset();
    onClose();
  };

  return (
    <Modal
      show={show}
      onClose={close}
      title="Edit Group"
      footerButtons={[
        <Button key="cancel" variant="secondary" onClick={close}>
          Cancel
        </Button>,
        <Button
          key="submit"
          type="submit"
          form="edit-group-form"
          isLoading={updateMutation.isPending}
        >
          Save
        </Button>,
      ]}
    >
      <GroupForm
        formId="edit-group-form"
        group={group}
        onSubmit={(updateData) => {
          if (Object.keys(updateData).length === 0) return close();
          updateMutation.mutate(
            { id: group.id, updateData: updateData as UpdateGroupInput },
            { onSuccess: close }
          );
        }}
        issues={issues}
        error={error}
      />
    </Modal>
  );
};

export default EditGroupModal;
