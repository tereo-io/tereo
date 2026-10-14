import useSaveProviderDomain from "@/features/auth-admin/api/identity-providers/useSaveProviderDomain";
import type { ProviderDomain } from "@/features/auth-admin/api/identity-providers/types";
import { Button, Modal } from "@kosmeo-ui/react";
import { DomainForm } from "../forms/DomainForm";

interface DomainModalProps {
  providerId: string;
  /** Set to edit this domain; unset to add one. */
  domain?: ProviderDomain;
  show: boolean;
  onClose: () => void;
}

const DomainModal = ({
  providerId,
  domain,
  show,
  onClose,
}: DomainModalProps) => {
  const saveMutation = useSaveProviderDomain();
  const formId = domain ? "edit-domain-form" : "add-domain-form";

  return (
    <Modal
      show={show}
      onClose={onClose}
      title={domain ? "Edit Domain" : "Add Domain"}
      size="lg"
      footerButtons={[
        <Button key="cancel" variant="secondary" onClick={onClose}>
          Cancel
        </Button>,
        <Button
          key="submit"
          type="submit"
          form={formId}
          isLoading={saveMutation.isPending}
        >
          {domain ? "Update Domain" : "Add Domain"}
        </Button>,
      ]}
    >
      <DomainForm
        formId={formId}
        domain={domain}
        onSubmit={(data) =>
          saveMutation.mutate(
            { providerId, domainId: domain?.id, data },
            { onSuccess: onClose }
          )
        }
      />
    </Modal>
  );
};

export default DomainModal;
