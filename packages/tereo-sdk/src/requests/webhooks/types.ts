/** Body of `POST /v1/webhooks/events`, as core's `emitEventSchema`. */
export interface EmitEventParams {
  organizationId: string;
  eventType: string;
  entityType: string;
  entityId: string;
  data: Record<string, unknown>;
  /** Idempotency key, held in Redis for 24h per (organization, event type). */
  idempotencyKey?: string;
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
