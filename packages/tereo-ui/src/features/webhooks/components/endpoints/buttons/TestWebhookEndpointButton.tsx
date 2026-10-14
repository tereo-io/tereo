import useTestWebhookEndpoint from "../../../api/endpoints/useTestWebhookEndpoint";
import type { WebhookEndpoint } from "../../../api/types";
import { Button } from "@kosmeo-ui/react";
import { useAuth } from "@/lib/auth";

interface TestWebhookEndpointButtonProps {
  endpoint: WebhookEndpoint;
  /** Called once core has queued the test delivery. */
  onSent?: (deliveryId: string) => void;
}

/** Core only tests ACTIVE, unarchived endpoints. */
const TestWebhookEndpointButton = ({
  endpoint,
  onSent,
}: TestWebhookEndpointButtonProps) => {
  const { hasPermission } = useAuth();
  const testMutation = useTestWebhookEndpoint();

  if (!hasPermission("webhooks.write") || endpoint.archivedAt) return null;

  const isActive = endpoint.status === "ACTIVE";

  return (
    <Button
      variant="secondary"
      size="sm"
      disabled={!isActive}
      title={isActive ? undefined : "Only active endpoints can be tested"}
      isLoading={testMutation.isPending}
      onClick={() =>
        testMutation.mutate(endpoint.id, {
          onSuccess: ({ deliveryId }) => onSent?.(deliveryId),
        })
      }
    >
      Send Test
    </Button>
  );
};

export default TestWebhookEndpointButton;
