/** Body of `POST /v1/webhooks/events`, as core's `emitEventSchema`. */
export interface EmitEventParams {
  organizationId: string;
  eventType: string;
  entityType: string;
  /** At most 500 characters. */
  entityId: string;
  /** At most 256 KiB as JSON. */
  data: Record<string, unknown>;
  /** Idempotency key, held in Redis for 24h per (organization, event type). */
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

export interface EmitBatchInput {
  events: EmitEventParams[];
}

export interface EmitBatchResult {
  results: (EmitEventResult & { eventType: string; entityId: string })[];
}
