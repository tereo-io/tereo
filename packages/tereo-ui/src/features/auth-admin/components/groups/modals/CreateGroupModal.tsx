import useAllOrganizations from "@/features/auth-admin/api/organizations/useAllOrganizations";
import type { CreateGroupInput } from "@/features/auth-admin/api/groups/types";
import useCreateGroup from "@/features/auth-admin/api/groups/useCreateGroup";
import { GroupForm, groupFormErrors } from "../forms/GroupForm";
import { Button, Modal } from "@kosmeo-ui/react";
import { useAuth } from "@/lib/auth";

interface CreateGroupModalProps {
  show: boolean;
  /** Fixes the group's organization. */
  organizationId?: string;
  onCreate: () => void;
  onClose: () => void;
}

const CreateGroupModal = ({
  show,
  organizationId,
  onCreate,
  onClose,
}: CreateGroupModalProps) => {
  const { hasPermission } = useAuth();
  const createMutation = useCreateGroup();
  // Only a holder of groups.write may create a global group, and the
  // picker lists organizations only to a reader of them.
  const canPick = !organizationId && hasPermission("organizations.read");
  const { data: organizations } = useAllOrganizations({
    enabled: show && canPick,
  });

  const { issues, error } = groupFormErrors(
    createMutation.error,
    "Failed to create group"
  );

  const close = () => {
    createMutation.reset();
    onClose();
  };

  return (
    <Modal
      show={show}
      onClose={close}
      title="Create Group"
      footerButtons={[
        <Button key="cancel" variant="secondary" onClick={close}>
          Cancel
        </Button>,
        <Button
          key="submit"
          type="submit"
          form="create-group-form"
          isLoading={createMutation.isPending}
        >
          Create Group
        </Button>,
      ]}
    >
      <GroupForm
        formId="create-group-form"
        organizationId={organizationId}
        organizations={canPick ? (organizations ?? []) : undefined}
        onSubmit={(data) =>
          createMutation.mutate(data as CreateGroupInput, {
            onSuccess: () => onCreate(),
          })
        }
        issues={issues}
        error={error}
      />
    </Modal>
  );
};

export default CreateGroupModal;
