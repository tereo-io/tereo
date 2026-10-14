import useBulkRetryDeliveries from "../../../api/deliveries/useBulkRetryDeliveries";
import type { BulkRetryInput, WebhookEndpoint } from "../../../api/types";
import { useState } from "react";
import {
  Button,
  Col,
  DateTimeInput,
  Form,
  Input,
  Modal,
  Select,
} from "@kosmeo-ui/react";

interface BulkRetryDeliveriesModalProps {
  endpoint: WebhookEndpoint;
  show: boolean;
  onClose: () => void;
}

const ALL = "__all__";

/**
 * Requeues the endpoint's FAILED deliveries, optionally narrowed by creation
 * window and event type, up to a limit (core: default 100, max 1000).
 */
const BulkRetryDeliveriesModal = ({
  endpoint,
  show,
  onClose,
}: BulkRetryDeliveriesModalProps) => {
  const [createdAfter, setCreatedAfter] = useState<string | null>(null);
  const [createdBefore, setCreatedBefore] = useState<string | null>(null);
  const [eventType, setEventType] = useState(ALL);
  const [limit, setLimit] = useState("100");

  const bulkRetry = useBulkRetryDeliveries();

  const eventTypeOptions = [
    { value: ALL, label: "All event types" },
    ...[...endpoint.eventTypes, "webhook.test"].map((et) => ({
      value: et,
      label: et,
    })),
  ];

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const input: BulkRetryInput = { limit: Number(limit) || 100 };
    if (createdAfter) input.createdAfter = createdAfter;
    if (createdBefore) input.createdBefore = createdBefore;
    if (eventType !== ALL) input.eventType = eventType;
    bulkRetry.mutate(
      { endpointId: endpoint.id, input },
      { onSuccess: () => onClose() }
    );
  };

  return (
    <Modal
      show={show}
      onClose={onClose}
      title="Retry Failed Deliveries"
      footerButtons={[
        <Button key="cancel" variant="secondary" onClick={onClose}>
          Cancel
        </Button>,
        <Button
          key="submit"
          type="submit"
          form="bulk-retry-deliveries-form"
          isLoading={bulkRetry.isPending}
        >
          Retry
        </Button>,
      ]}
    >
      <Form onSubmit={handleSubmit} id="bulk-retry-deliveries-form">
        <Col>
          <p className="t-webhook-help v-muted-text">
            Failed deliveries matching these filters are reset and queued again.
            Leave a field empty to not filter on it.
          </p>
          <DateTimeInput
            label="Created after"
            value={createdAfter}
            onChange={setCreatedAfter}
          />
          <DateTimeInput
            label="Created before"
            value={createdBefore}
            onChange={setCreatedBefore}
          />
          <Select
            label="Event type"
            value={eventType}
            onChange={(v) => setEventType(v ?? ALL)}
            options={eventTypeOptions}
          />
          <Input
            label="Limit"
            type="number"
            min={1}
            max={1000}
            required
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            helperText="At most 1000 deliveries per request."
          />
        </Col>
      </Form>
    </Modal>
  );
};

export default BulkRetryDeliveriesModal;
