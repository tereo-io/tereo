import useCreateIdentityProvider from "@/features/auth-admin/api/identity-providers/useCreateIdentityProvider";
import { IdentityProviderForm } from "../forms/IdentityProviderForm";
import { Button, Modal } from "@kosmeo-ui/react";
import type {
  CreateIdentityProviderInput,
  IdentityProvider,
} from "@/features/auth-admin/api/identity-providers/types";

interface CreateIdentityProviderModalProps {
  show: boolean;
  onCreate: (provider: IdentityProvider) => void;
  onClose: () => void;
}

const CreateIdentityProviderModal = (
  props: CreateIdentityProviderModalProps
) => {
  const createMutation = useCreateIdentityProvider();

  return (
    <Modal
      show={props.show}
      onClose={props.onClose}
      title="Add Identity Provider"
      size="lg"
      footerButtons={[
        <Button key="cancel" variant="secondary" onClick={props.onClose}>
          Cancel
        </Button>,
        <Button
          key="submit"
          type="submit"
          form="create-identity-provider-form"
          isLoading={createMutation.isPending}
        >
          Add Provider
        </Button>,
      ]}
    >
      <IdentityProviderForm
        formId="create-identity-provider-form"
        onSubmit={(data) =>
          createMutation.mutate(data as CreateIdentityProviderInput, {
            onSuccess: props.onCreate,
          })
        }
      />
    </Modal>
  );
};

export default CreateIdentityProviderModal;
