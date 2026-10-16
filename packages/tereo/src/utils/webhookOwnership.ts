import type { AuthContext } from "../middleware/auth.js";
import { ForbiddenError } from "./errors.js";
import type { Request } from "express";
import db from "./db/index.js";

/**
 * An integration manages its own webhook endpoints: on the endpoint routes it
 * needs no `webhooks.*` permission, and sees and changes only the endpoints
 * it owns (`owner_service_id`). Its endpoints are in its organization, or, for
 * a platform integration, sent every organization's events.
 */
export interface CallerIntegration {
  id: string;
  slug: string;
  organizationId: string | null;
}

declare global {
  namespace Express {
    interface Request {
      /** Set on the webhook endpoint routes when the caller is an integration. */
      webhookOwner?: CallerIntegration;
    }
  }
}

/** The integration whose service account is calling, or null. */
export const callerIntegration = async (
  auth: Pick<AuthContext, "oauthClientId">
): Promise<CallerIntegration | null> => {
  if (!auth.oauthClientId) return null;
  const service = await db.services.getByClientId(auth.oauthClientId);
  if (service?.kind !== "integration") return null;
  return {
    id: service.id,
    slug: service.slug,
    organizationId: service.organizationId,
  };
};

/**
 * Whose endpoints a request acts on: an integration's own (`owner`, in its
 * organization or none), or the request organization's.
 */
export interface WebhookScope {
  organizationId: string | null;
  owner: CallerIntegration | null;
}

export const webhookScope = (req: Request): WebhookScope => {
  if (req.webhookOwner) {
    return {
      organizationId: req.webhookOwner.organizationId,
      owner: req.webhookOwner,
    };
  }
  if (!req.organizationId) {
    throw new ForbiddenError("Organization context required");
  }
  return { organizationId: req.organizationId, owner: null };
};
