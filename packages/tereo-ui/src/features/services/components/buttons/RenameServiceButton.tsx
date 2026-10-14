import { Button, Form, Input, Modal } from "@kosmeo-ui/react";
import useUpdateService from "../../api/useUpdateService";
import type { Service } from "../../api/types";
import { toast } from "react-toastify";
import { useState } from "react";

const FORM_ID = "rename-service-form";

/** Only the display name changes; slug and namespace are fixed. */
const RenameServiceButton = ({ service }: { service: Service }) => {
  const [show, setShow] = useState(false);
  const [name, setName] = useState(service.name);
  const updateMutation = useUpdateService();

  const open = () => {
    setName(service.name);
    setShow(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed === service.name) {
      setShow(false);
      return;
    }
    updateMutation.mutate(
      { id: service.id, data: { name: trimmed } },
      {
        onSuccess: () => {
          toast.success("Service renamed");
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
        title="Rename Service"
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
            helperText="The slug and namespace stay as they are."
            required
            autoFocus
          />
        </Form>
      </Modal>
    </>
  );
};

export default RenameServiceButton;
