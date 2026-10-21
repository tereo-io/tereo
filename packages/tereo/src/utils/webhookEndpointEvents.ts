import type { Prisma } from "./db/prisma.js";
import { emitTx } from "./outbox.js";

export type WebhookEndpointEvent =
  | "created"
  | "updated"
  | "archived"
  | "restored"
  | "deleted"
  | "secret-rotated"
  | "previous-secret-revoked";

interface EventEndpoint {
  id: string;
  organizationId: string | null;
  ownerServiceId: string | null;
  url: string;
  description: string | null;
  status: string;
  eventTypes: string[];
  customHeaders: unknown;
  provisioned: boolean;
  createdBy: string;
  archivedAt: Date | null;
}

/**
 * Origin and path only: a query string or user-info may carry a credential
 * the receiver checks, which the audit log and event subscribers must not see.
 */
export const redactWebhookUrl = (url: string): string => {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "[invalid url]";
  }
};

const customHeaderNames = (headers: unknown): string[] =>
  headers && typeof headers === "object" ? Object.keys(headers).sort() : [];

/**
 * Emits `webhook.endpoint.<action>`. An endpoint of all organizations has
 * none, so its events go to the endpoints of all organizations and its
 * owner's. Carries neither the signing secret nor custom header values.
 */
export const emitEndpointEventTx = async (
  tx: Prisma.TransactionClient,
  action: WebhookEndpointEvent,
  endpoint: EventEndpoint,
  extra: Record<string, unknown> = {}
) => {
  await emitTx(tx, {
    eventType: `webhook.endpoint.${action}`,
    organizationId: endpoint.organizationId,
    serviceId: endpoint.organizationId ? null : endpoint.ownerServiceId,
    entityType: "WebhookEndpoint",
    entityId: endpoint.id,
    data: {
      id: endpoint.id,
      organizationId: endpoint.organizationId,
      ownerServiceId: endpoint.ownerServiceId,
      url: redactWebhookUrl(endpoint.url),
      description: endpoint.description,
      status: endpoint.status,
      eventTypes: endpoint.eventTypes,
      customHeaderNames: customHeaderNames(endpoint.customHeaders),
      provisioned: endpoint.provisioned,
      createdBy: endpoint.createdBy,
      archivedAt: endpoint.archivedAt,
      ...extra,
    },
  });
};
