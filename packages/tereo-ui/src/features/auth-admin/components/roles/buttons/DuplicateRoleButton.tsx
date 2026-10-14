import useDuplicateRole from "@/features/auth-admin/api/roles/useDuplicateRole";
import { Button, Col, Form, IconButton, Input, Modal } from "@kosmeo-ui/react";
import { Role } from "@/features/auth-admin/api/roles/types";
import { faCopy } from "@fortawesome/free-solid-svg-icons";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { useState } from "react";

interface DuplicateRoleButtonProps {
  role: Role;
}

// Copies the role — system or custom — into a new custom role with the same
// (unretired) permissions, which the admin can then edit.
const DuplicateRoleButton = ({ role }: DuplicateRoleButtonProps) => {
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const [showModal, setShowModal] = useState(false);
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");

  const duplicateMutation = useDuplicateRole();

  if (!hasPermission("roles.write")) return null;

  const handleOpen = () => {
    setName(`${role.name}_copy`);
    setDisplayName(`${role.displayName} (copy)`);
    setShowModal(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    duplicateMutation.mutate(
      {
        id: role.id,
        input: { name, displayName: displayName || undefined },
      },
      {
        onSuccess: (created) => {
          setShowModal(false);
          navigate(`/auth-admin/roles/${created.id}`);
        },
      }
    );
  };

  return (
    <>
      <IconButton
        icon={faCopy}
        title="Duplicate"
        variant="secondary"
        size="sm"
        onClick={handleOpen}
      />
      <Modal
        show={showModal}
        onClose={() => setShowModal(false)}
        title="Duplicate Role"
        footerButtons={[
          <Button
            key="cancel"
            variant="secondary"
            onClick={() => setShowModal(false)}
          >
            Cancel
          </Button>,
          <Button
            key="submit"
            type="submit"
            form="duplicate-role-form"
            isLoading={duplicateMutation.isPending}
          >
            Duplicate Role
          </Button>,
        ]}
      >
        <Form onSubmit={handleSubmit} id="duplicate-role-form">
          <Col>
            <p className="v-help-text">
              Creates a custom role with the same permissions as &quot;
              {role.displayName}&quot;.
            </p>
            <Input
              label="Name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
            <Input
              label="Display Name"
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              required
            />
          </Col>
        </Form>
      </Modal>
    </>
  );
};

export default DuplicateRoleButton;
