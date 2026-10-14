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
  entityId: string;
  data: Record<string, unknown>;
  /** Optional idempotency key to prevent duplicate processing (24h TTL on service). */
  idempotencyKey?: string;
}

export interface EmitEventResult {
  deliveriesCreated: number;
}

export interface EmitBatchResult {
  results: (EmitEventResult & { eventType: string; entityId: string })[];
}
