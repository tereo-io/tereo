import useUpdateIntegration from "../../api/useUpdateIntegration";
import { Button, Form, Input, Modal } from "@kosmeo-ui/react";
import type { Integration } from "../../api/types";
import { toast } from "react-toastify";
import { useState } from "react";

const FORM_ID = "rename-integration-form";

/** Only the display name changes; the slug and organization are fixed. */
const RenameIntegrationButton = ({
  integration,
}: {
  integration: Integration;
}) => {
  const [show, setShow] = useState(false);
  const [name, setName] = useState(integration.name);
  const updateMutation = useUpdateIntegration();

  const open = () => {
    setName(integration.name);
    setShow(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed === integration.name) {
      setShow(false);
      return;
    }
    updateMutation.mutate(
      { id: integration.id, data: { name: trimmed } },
      {
        onSuccess: () => {
          toast.success("Integration renamed");
          setShow(false);
        },
      }
    );
  };

  return (
    <>
      <Button variant="secondary" size="sm" onClick={open}>
        Rename
      </Button>
      <Modal
        show={show}
        onClose={() => setShow(false)}
        title="Rename Integration"
        size="sm"
        footerButtons={[
          <Button
            key="cancel"
            variant="secondary"
            onClick={() => setShow(false)}
          >
            Cancel
          </Button>,
          <Button
            key="submit"
            type="submit"
            form={FORM_ID}
            isLoading={updateMutation.isPending}
          >
            Save
          </Button>,
        ]}
      >
        <Form id={FORM_ID} onSubmit={handleSubmit}>
          <Input
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            helperText="The slug stays as it is."
            required
            autoFocus
          />
        </Form>
      </Modal>
    </>
  );
};

export default RenameIntegrationButton;
