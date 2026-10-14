import type { WebhookDelivery, WebhookEndpoint } from "../../../api/types";
import useRetryDelivery from "../../../api/deliveries/useRetryDelivery";
import { faRotateRight } from "@fortawesome/free-solid-svg-icons";
import { Button, IconButton } from "@kosmeo-ui/react";
import { useAuth } from "@/lib/auth";

interface RetryDeliveryButtonProps {
  endpoint: WebhookEndpoint;
  delivery: WebhookDelivery;
  /** Icon-only for table rows; a labelled button elsewhere. */
  compact?: boolean;
  onRetried?: () => void;
}

/** Core retries FAILED deliveries only, and only on ACTIVE endpoints. */
const RetryDeliveryButton = ({
  endpoint,
  delivery,
  compact = false,
  onRetried,
}: RetryDeliveryButtonProps) => {
  const { hasPermission } = useAuth();
  const retryMutation = useRetryDelivery();

  if (
    !hasPermission("webhooks.write") ||
    endpoint.archivedAt ||
    endpoint.status !== "ACTIVE" ||
    delivery.status !== "FAILED"
  )
    return null;

  const retry = () =>
    retryMutation.mutate(
      { endpointId: endpoint.id, deliveryId: delivery.id },
      { onSuccess: () => onRetried?.() }
    );

  return compact ? (
    <IconButton
      icon={faRotateRight}
      title="Retry"
      variant="secondary"
      size="sm"
      isLoading={retryMutation.isPending}
      onClick={retry}
    />
  ) : (
    <Button
      variant="secondary"
      isLoading={retryMutation.isPending}
      onClick={retry}
    >
      Retry Delivery
    </Button>
  );
};

export default RetryDeliveryButton;
