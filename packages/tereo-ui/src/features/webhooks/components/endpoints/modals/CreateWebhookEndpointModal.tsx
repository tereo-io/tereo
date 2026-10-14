import useCreateWebhookEndpoint from "../../../api/endpoints/useCreateWebhookEndpoint";
import { WebhookEndpointForm } from "../forms/WebhookEndpointForm";
import { WebhookSecretDisplay } from "../WebhookSecretDisplay";
import { Button, Modal } from "@kosmeo-ui/react";
import { toast } from "react-toastify";
import { useState } from "react";
import type {
  CreateWebhookEndpointInput,
  WebhookEndpoint,
} from "../../../api/types";

interface CreateWebhookEndpointModalProps {
  show: boolean;
  onCreate: () => void;
  onClose: () => void;
}

const CreateWebhookEndpointModal = (props: CreateWebhookEndpointModalProps) => {
  const [created, setCreated] = useState<WebhookEndpoint | null>(null);

  const createMutation = useCreateWebhookEndpoint();

  const handleCreate = (data: CreateWebhookEndpointInput) => {
    createMutation.mutate(data, {
      // Core returns the full signing secret on create, and only then.
      onSuccess: (endpoint) => setCreated(endpoint),
    });
  };

  const handleSecretModalClose = () => {
    setCreated(null);
    toast.success("Webhook endpoint created");
    props.onCreate();
  };

  return (
    <>
      <Modal
        show={props.show && !created}
        onClose={props.onClose}
        title="Create Webhook Endpoint"
        size="lg"
        footerButtons={[
          <Button key="cancel" variant="secondary" onClick={props.onClose}>
            Cancel
          </Button>,
          <Button
            key="submit"
            type="submit"
            form="create-webhook-endpoint-form"
            isLoading={createMutation.isPending}
          >
            Create Endpoint
          </Button>,
        ]}
      >
        {/* Remount per opening so a cancelled draft doesn't linger. */}
        {props.show && (
          <WebhookEndpointForm
            formId="create-webhook-endpoint-form"
            onSubmit={(data) =>
              handleCreate(data as CreateWebhookEndpointInput)
            }
          />
        )}
      </Modal>

      <Modal
        show={!!created}
        onClose={handleSecretModalClose}
        title="Webhook Endpoint Created"
        footerButtons={[
          <Button key="close" onClick={handleSecretModalClose}>
            I have saved the signing secret
          </Button>,
        ]}
      >
        {created && (
          <WebhookSecretDisplay
            url={created.url}
            signingSecret={created.signingSecret}
          />
        )}
      </Modal>
    </>
  );
};

export default CreateWebhookEndpointModal;
