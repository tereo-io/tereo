import useSetIntegrationAudiences from "../../api/useSetIntegrationAudiences";
import { CORE_SERVICE_ID, useServices } from "@/features/services";
import type { Integration } from "../../api/types";
import { useState } from "react";
import {
  Button,
  CheckboxGroup,
  Col,
  EmptyState,
  Modal,
  Spinner,
} from "@kosmeo-ui/react";

/** Audiences are services other than core; an integration cannot be one. */
const EditIntegrationAudiencesButton = ({
  integration,
}: {
  integration: Integration;
}) => {
  const [show, setShow] = useState(false);
  const [selected, setSelected] = useState<string[] | null>(null);
  const { data: services, isLoading } = useServices();
  const { mutate, isPending } = useSetIntegrationAudiences();

  const options = (services ?? []).filter((s) => s.id !== CORE_SERVICE_ID);
  const values = selected ?? integration.audience;

  const handleClose = () => {
    setShow(false);
    setSelected(null);
  };

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setShow(true)}>
        Edit Audiences
      </Button>
      <Modal
        show={show}
        onClose={handleClose}
        title="Integration Audiences"
        footerButtons={[
          <Button
            key="cancel"
            variant="secondary"
            onClick={handleClose}
            disabled={isPending}
          >
            Cancel
          </Button>,
          <Button
            key="save"
            isLoading={isPending}
            disabled={isPending || isLoading}
            onClick={() =>
              mutate(
                { id: integration.id, slugs: values },
                { onSuccess: handleClose }
              )
            }
          >
            Save Audiences
          </Button>,
        ]}
      >
        <Col size="md">
          <p>
            The services <strong>{integration.name}</strong>&apos;s tokens may
            call.
          </p>
          {isLoading ? (
            <Spinner size="md" />
          ) : options.length === 0 ? (
            <EmptyState>No services to choose from</EmptyState>
          ) : (
            <CheckboxGroup
              name={`integration-audiences-${integration.id}`}
              options={options.map((s) => ({
                value: s.slug,
                label: `${s.name} (${s.slug})`,
              }))}
              values={values}
              onChange={setSelected}
            />
          )}
        </Col>
      </Modal>
    </>
  );
};

export default EditIntegrationAudiencesButton;
