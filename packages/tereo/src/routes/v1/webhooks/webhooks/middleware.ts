import { resolveWebhookOrganizationId } from "../../../../middleware/organizationId.js";
import { callerIntegration } from "../../../../utils/webhookOwnership.js";
import { requirePermission } from "../../../../middleware/auth.js";
import { Request, Response, NextFunction } from "express";

/**
 * An integration acts on its own endpoints, whatever its token's organization
 * or `X-Organization-ID`; any other caller on its organization's.
 */
export const resolveWebhookCaller = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const integration = req.auth ? await callerIntegration(req.auth) : null;
  if (integration) {
    req.webhookOwner = integration;
    return next();
  }
  return resolveWebhookOrganizationId(req, res, next);
};

/**
 * `requirePermission`, except for an integration on its own endpoints, which
 * needs none: each route still finds only endpoints it owns.
 */
export const requireWebhookPermission =
  (permission: string) => (req: Request, res: Response, next: NextFunction) =>
    req.webhookOwner ? next() : requirePermission(permission)(req, res, next);
