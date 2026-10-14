import type { WebhookDelivery, WebhookEndpoint } from "../../../api/types";
import RetryDeliveryButton from "../buttons/RetryDeliveryButton";
import useDelivery from "../../../api/deliveries/useDelivery";
import { DeliveryStatusBadge } from "../../badges";
import formatDate from "@/utils/formatDate";
import "../../styles.css";
import {
  Button,
  Centered,
  Col,
  EmptyState,
  InfoRow,
  Modal,
  SectionHeader,
  Spinner,
} from "@kosmeo-ui/react";

interface DeliveryDetailModalProps {
  endpoint: WebhookEndpoint;
  deliveryId: string | null;
  onClose: () => void;
}

/** Pretty-prints a JSON response body; anything else is shown as-is. */
const formatBody = (body: string) => {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
};

const DeliveryDetailModal = ({
  endpoint,
  deliveryId,
  onClose,
}: DeliveryDetailModalProps) => {
  const { data: delivery, isLoading } = useDelivery(endpoint.id, deliveryId);

  return (
    <Modal
      show={!!deliveryId}
      onClose={onClose}
      title="Delivery Details"
      size="lg"
      footerButtons={[
        ...(delivery
          ? [
              <RetryDeliveryButton
                key="retry"
                endpoint={endpoint}
                delivery={delivery}
              />,
            ]
          : []),
        <Button key="close" variant="secondary" onClick={onClose}>
          Close
        </Button>,
      ]}
    >
      {isLoading ? (
        <Centered>
          <Spinner />
        </Centered>
      ) : delivery ? (
        <DeliveryDetail delivery={delivery} />
      ) : (
        <EmptyState>Delivery not found</EmptyState>
      )}
    </Modal>
  );
};

const DeliveryDetail = ({ delivery }: { delivery: WebhookDelivery }) => (
  <Col size="md">
    <Col size="sm">
      <InfoRow
        label="Delivery ID"
        value={<span className="v-mono">{delivery.id}</span>}
      />
      <InfoRow
        label="Status"
        value={<DeliveryStatusBadge status={delivery.status} />}
      />
      <InfoRow
        label="Event Type"
        value={<span className="v-mono">{delivery.eventType}</span>}
      />
      <InfoRow label="Attempts" value={delivery.attempts} />
      <InfoRow
        label="Response Status"
        value={delivery.httpStatus ?? <span className="v-muted-text">—</span>}
      />
      <InfoRow label="Created" value={formatDate(delivery.createdAt)} />
      <InfoRow
        label="Last Attempt"
        value={
          delivery.lastAttemptAt ? (
            formatDate(delivery.lastAttemptAt)
          ) : (
            <span className="v-muted-text">Not attempted yet</span>
          )
        }
      />
      {delivery.completedAt && (
        <InfoRow label="Completed" value={formatDate(delivery.completedAt)} />
      )}
    </Col>

    {delivery.errorMessage && (
      <>
        <SectionHeader title="Last Error" as="h4" dense />
        <pre className="t-webhook-code">{delivery.errorMessage}</pre>
      </>
    )}

    <SectionHeader title="Last Response Body" as="h4" dense />
    {delivery.responseBody ? (
      <pre className="t-webhook-code">{formatBody(delivery.responseBody)}</pre>
    ) : (
      <EmptyState>
        {delivery.payloadRedacted
          ? "Hidden: you can't read this event"
          : "No response body recorded"}
      </EmptyState>
    )}

    <SectionHeader title="Request Payload" as="h4" dense />
    {delivery.payloadRedacted ? (
      <EmptyState>Hidden: you can't read this event</EmptyState>
    ) : (
      <pre className="t-webhook-code">
        {JSON.stringify(delivery.payload, null, 2)}
      </pre>
    )}
  </Col>
);

export default DeliveryDetailModal;
