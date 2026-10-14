import { UserRolesEditor, UserRolesEditorRef } from "./UserRolesEditor";
import useUserRoles from "@/features/auth-admin/api/users/useUserRoles";
import { Button, Modal } from "@kosmeo-ui/react";
import { useState, useRef } from "react";

interface ManageRolesButtonProps {
  userId: string;
}

const ManageRolesButton = ({ userId }: ManageRolesButtonProps) => {
  const [showRolesModal, setShowRolesModal] = useState(false);
  const rolesEditorRef = useRef<UserRolesEditorRef>(null);

  const { data: rolesData } = useUserRoles(userId);

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setShowRolesModal(true)}
      >
        Manage Roles
      </Button>
      <Modal
        show={showRolesModal}
        onClose={() => setShowRolesModal(false)}
        title="Manage User Roles"
        size="lg"
        footerButtons={[
          <Button
            key="cancel"
            variant="secondary"
            onClick={() => setShowRolesModal(false)}
          >
            Cancel
          </Button>,
          <Button key="save" onClick={() => rolesEditorRef.current?.save()}>
            Save Roles
          </Button>,
        ]}
      >
        <UserRolesEditor
          ref={rolesEditorRef}
          userId={userId}
          currentRoles={rolesData?.roles || []}
          onSuccess={() => setShowRolesModal(false)}
        />
      </Modal>
    </>
  );
};

export default ManageRolesButton;
