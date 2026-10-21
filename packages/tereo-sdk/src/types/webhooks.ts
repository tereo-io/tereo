export interface WebhookServiceClientConfig {
  /**
   * The event types this service declares. Optional: given, `emit` rejects
   * any other before calling core; core enforces ownership either way.
   */
  eventTypes?: string[];
}

export interface EmitEventParams {
  organizationId: string;
  eventType: string;
  entityType: string;
  /** At most 500 characters. */
  entityId: string;
  /** At most 256 KiB as JSON. */
  data: Record<string, unknown>;
  /** Optional idempotency key to prevent duplicate processing (24h TTL on service). */
  idempotencyKey?: string;
  /**
   * Slugs of services or integrations (at most 50): the event goes only to
   * webhook endpoints they own, each still subject to its owner's read
   * permission. Core refuses an unknown slug.
   */
  recipients?: string[];
}

export interface EmitEventResult {
  deliveriesCreated: number;
}

export interface EmitBatchResult {
  results: (EmitEventResult & { eventType: string; entityId: string })[];
}
