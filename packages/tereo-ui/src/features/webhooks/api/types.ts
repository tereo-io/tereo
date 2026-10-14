// Shapes returned by core's webhooks area (`/v1/webhooks/...`). See
// packages/tereo/src/routes/v1/webhooks and docs/webhooks.md.

import type { UserRef } from "@/lib/refs";

/** ACTIVE/PAUSED are set by admins; DISABLED is set by core after repeated failures. */
export type WebhookEndpointStatus = "ACTIVE" | "PAUSED" | "DISABLED";

export type WebhookDeliveryStatus = "PENDING" | "SUCCESS" | "FAILED";

export interface WebhookEndpoint {
  id: string;
  organizationId: string;
  url: string;
  description: string | null;
  /** Masked (`first8...`) on every read; full only on create and rotate. */
  signingSecret: string;
  status: WebhookEndpointStatus;
  customHeaders: Record<string, string> | null;
  consecutiveFailures: number;
  archivedAt: string | null;
  /** Until then the secret replaced by the last rotation also signs deliveries. */
  previousSecretExpiresAt: string | null;
  /** Core 409s a hard delete while delivery history references the endpoint. */
  hasDeliveries: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  creator: UserRef;
  eventTypes: string[];
  /** Subscribed event types whose service no longer declares them. */
  retiredEventTypes: string[];
  /** Present on `GET /webhooks/:id` only. */
  _count?: { deliveries: number };
}

export interface CreateWebhookEndpointInput {
  url: string;
  description?: string;
  eventTypes: string[];
  customHeaders?: Record<string, string>;
}

export interface UpdateWebhookEndpointInput {
  url?: string;
  description?: string | null;
  eventTypes?: string[];
  status?: "ACTIVE" | "PAUSED";
  customHeaders?: Record<string, string> | null;
}

export interface WebhookEndpointStats {
  /** The counts cover deliveries created in the last `windowDays` days. */
  windowDays: number;
  total: number;
  success: number;
  failed: number;
  pending: number;
  successRate: number;
  averageAttempts: number;
  last24Hours: {
    total: number;
    success: number;
    failed: number;
    pending: number;
  };
}

export interface WebhookDelivery {
  id: string;
  webhookEndpointId: string;
  eventType: string;
  /** Null, like `responseBody`, when `payloadRedacted`. */
  payload: Record<string, unknown> | null;
  /** The caller could not read this delivery's event themselves. */
  payloadRedacted: boolean;
  status: WebhookDeliveryStatus;
  attempts: number;
  lastAttemptAt: string | null;
  httpStatus: number | null;
  responseBody: string | null;
  errorMessage: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BulkRetryInput {
  createdAfter?: string;
  createdBefore?: string;
  eventType?: string;
  limit?: number;
}

export interface EventType {
  eventType: string;
  description: string | null;
  /** The declaring service's namespace. */
  source: string;
  serviceId: string;
  serviceName: string;
  /** Set when the service stopped declaring it; it retires a day later. */
  missingSince: string | null;
  retiredAt: string | null;
  createdAt: string;
}

/** Event types have no `id` (the name is the key); list hooks key rows by `eventType`. */
export type EventTypeRow = EventType & { id: string };

export interface CursorPage<T> {
  data: T[];
  hasMore: boolean;
  limit: number;
  nextCursor: string | null;
}
