import { Role } from "@/features/auth-admin/api/roles/types";
import { Button, Modal } from "@kosmeo-ui/react";
import { useState, useRef } from "react";
import {
  RolePermissionsEditor,
  RolePermissionsEditorRef,
} from "./RolePermissionsEditor";

interface ManagePermissionsButtonProps {
  role: Role;
}

const ManagePermissionsButton = ({ role }: ManagePermissionsButtonProps) => {
  const [showPermissionsModal, setShowPermissionsModal] = useState(false);
  const permissionsEditorRef = useRef<RolePermissionsEditorRef>(null);

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setShowPermissionsModal(true)}
      >
        Manage Permissions
      </Button>
      <Modal
        show={showPermissionsModal}
        onClose={() => setShowPermissionsModal(false)}
        title="Manage Role Permissions"
        size="lg"
        footerButtons={[
          <Button
            key="cancel"
            variant="secondary"
            onClick={() => setShowPermissionsModal(false)}
          >
            Cancel
          </Button>,
          <Button
            key="save"
            onClick={() => permissionsEditorRef.current?.save()}
          >
            Save Permissions
          </Button>,
        ]}
      >
        <RolePermissionsEditor
          ref={permissionsEditorRef}
          roleId={role.id}
          currentPermissions={role.permissions || []}
          onSuccess={() => setShowPermissionsModal(false)}
        />
      </Modal>
    </>
  );
};

export default ManagePermissionsButton;
