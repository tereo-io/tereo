import { ServiceCredentialsDisplay } from "../ServiceCredentialsDisplay";
import { Button, Col, Form, Input, Modal } from "@kosmeo-ui/react";
import useCreateService from "../../api/useCreateService";
import type { CreatedService } from "../../api/types";
import { useNavigate } from "react-router-dom";
import { toast } from "react-toastify";
import { useState } from "react";

interface CreateServiceModalProps {
  show: boolean;
  onClose: () => void;
}

// The defaults core applies when slug or namespace is left out.
const slugify = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^a-z]+/, "");
const namespaceOf = (slug: string) => slug.replace(/-service$/, "");

const FORM_ID = "create-service-form";

const CreateServiceModal = ({ show, onClose }: CreateServiceModalProps) => {
  const navigate = useNavigate();
  const createMutation = useCreateService();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [namespace, setNamespace] = useState("");
  const [created, setCreated] = useState<CreatedService | null>(null);

  const defaultSlug = slugify(name);
  const defaultNamespace = namespaceOf(slug || defaultSlug);

  const reset = () => {
    setName("");
    setSlug("");
    setNamespace("");
    createMutation.reset();
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    createMutation.mutate(
      {
        name: name.trim(),
        ...(slug && { slug }),
        ...(namespace && { namespace }),
      },
      { onSuccess: setCreated }
    );
  };

  const handleCredentialsSaved = () => {
    if (!created) return;
    toast.success(`Service "${created.name}" added`);
    const id = created.id;
    setCreated(null);
    reset();
    onClose();
    navigate(`/services/${id}`);
  };

  return (
    <>
      <Modal
        show={show && !created}
        onClose={handleClose}
        title="Add Service"
        footerButtons={[
          <Button key="cancel" variant="secondary" onClick={handleClose}>
            Cancel
          </Button>,
          <Button
            key="submit"
            type="submit"
            form={FORM_ID}
            isLoading={createMutation.isPending}
          >
            Add Service
          </Button>,
        ]}
      >
        <Form id={FORM_ID} onSubmit={handleSubmit}>
          <Col>
            <Input
              label="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Billing Service"
              required
              autoFocus
            />
            <Input
              label="Slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
              placeholder={defaultSlug || "product-service"}
              helperText="Identifies the service; other services name its roles as <slug>/<role>. Defaults to the name, hyphenated."
            />
            <Input
              label="Namespace"
              value={namespace}
              onChange={(e) => setNamespace(e.target.value.toLowerCase())}
              placeholder={defaultNamespace || "product"}
              helperText="Prefixes every permission, event type and bucket the service declares. Defaults to the slug without “-service”. It cannot be changed later."
            />
          </Col>
        </Form>
      </Modal>

      <Modal
        show={!!created}
        onClose={handleCredentialsSaved}
        title="Service Added"
        footerButtons={[
          <Button key="close" onClick={handleCredentialsSaved}>
            I have saved these credentials
          </Button>,
        ]}
      >
        {created && (
          <ServiceCredentialsDisplay credentials={created.credentials} />
        )}
      </Modal>
    </>
  );
};

export default CreateServiceModal;
