import useAllOrganizations from "@/features/auth-admin/api/organizations/useAllOrganizations";
import { IntegrationCredentialsDisplay } from "../IntegrationCredentialsDisplay";
import { Button, Col, Form, Input, Modal, Select } from "@kosmeo-ui/react";
import useCreateIntegration from "../../api/useCreateIntegration";
import type { CreatedIntegration } from "../../api/types";
import { useNavigate } from "react-router-dom";
import { toast } from "react-toastify";
import { useState } from "react";

interface CreateIntegrationModalProps {
  show: boolean;
  onClose: () => void;
}

// The default core applies when the slug is left out.
const slugify = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^a-z]+/, "");

const FORM_ID = "create-integration-form";
const PLATFORM = "";

const CreateIntegrationModal = ({
  show,
  onClose,
}: CreateIntegrationModalProps) => {
  const navigate = useNavigate();
  const createMutation = useCreateIntegration();
  const { data: organizations } = useAllOrganizations();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [organizationId, setOrganizationId] = useState(PLATFORM);
  const [created, setCreated] = useState<CreatedIntegration | null>(null);

  const reset = () => {
    setName("");
    setSlug("");
    setOrganizationId(PLATFORM);
    createMutation.reset();
  };

  // Closing mid-request would reset the mutation and drop its result: the
  // secret, shown only once.
  const handleClose = () => {
    if (createMutation.isPending) return;
    reset();
    onClose();
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    createMutation.mutate(
      {
        name: name.trim(),
        ...(slug && { slug }),
        ...(organizationId && { organizationId }),
      },
      { onSuccess: setCreated }
    );
  };

  const handleCredentialsSaved = () => {
    if (!created) return;
    toast.success(`Integration "${created.name}" added`);
    const id = created.id;
    setCreated(null);
    reset();
    onClose();
    navigate(`/integrations/${id}`);
  };

  return (
    <>
      <Modal
        show={show && !created}
        onClose={handleClose}
        title="Add Integration"
        footerButtons={[
          <Button
            key="cancel"
            variant="secondary"
            onClick={handleClose}
            disabled={createMutation.isPending}
          >
            Cancel
          </Button>,
          <Button
            key="submit"
            type="submit"
            form={FORM_ID}
            isLoading={createMutation.isPending}
          >
            Add Integration
          </Button>,
        ]}
      >
        <Form id={FORM_ID} onSubmit={handleSubmit}>
          <Col>
            <Input
              label="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Acme 3PL"
              required
              autoFocus
            />
            <Input
              label="Slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
              placeholder={slugify(name) || "acme-3pl"}
              helperText="Identifies the integration. Defaults to the name, hyphenated."
            />
            <Select
              label="Organization"
              value={organizationId}
              options={[
                { value: PLATFORM, label: "None (platform integration)" },
                ...(organizations ?? []).map((o) => ({
                  value: o.id,
                  label: o.name,
                })),
              ]}
              onChange={(value) => setOrganizationId(value ?? PLATFORM)}
            />
            <p className="v-help-text">
              The organization is fixed once set. An org-bound integration works
              inside that organization with org roles; a platform one gets
              global roles.
            </p>
          </Col>
        </Form>
      </Modal>

      <Modal
        show={!!created}
        onClose={handleCredentialsSaved}
        title="Integration Added"
        footerButtons={[
          <Button key="close" onClick={handleCredentialsSaved}>
            I have saved these credentials
          </Button>,
        ]}
      >
        {created && (
          <IntegrationCredentialsDisplay credentials={created.credentials} />
        )}
      </Modal>
    </>
  );
};

export default CreateIntegrationModal;
