import { CheckPermissionSchema, CheckPermissionsSchema } from "./schemas.js";
import { ForbiddenError, NotFoundError } from "../../../utils/errors.js";
import type { ClientRecord } from "../../../utils/db/clients.js";
import { hasPermission } from "../../../utils/permissions.js";
import { validateBody } from "../../../utils/validateReq.js";
import type { Request, Response } from "express";
import db from "../../../utils/db/index.js";
import {
  authenticateClient,
  clientAuthenticationFailed,
  isActiveOrganization,
  parseBasicAuth,
} from "../../../utils/auth.js";

export const checkPermission = async (req: Request, res: Response) => {
  const client = await verifyClientCredentials(req, res);

  const body = validateBody(CheckPermissionSchema, req);

  const userPermissions = await permissionsInClientOrg(client, body);
  const granted = hasPermission(userPermissions, body.permission);

  res.json({ granted });
};

export const checkPermissions = async (req: Request, res: Response) => {
  const client = await verifyClientCredentials(req, res);

  const body = validateBody(CheckPermissionsSchema, req);

  const userPermissions = await permissionsInClientOrg(client, body);

  const results: Record<string, boolean> = {};
  for (const permission of body.permissions) {
    results[permission] = hasPermission(userPermissions, permission);
  }

  res.json({ results });
};

/**
 * The user's permissions as far as the asking client may know them. A client
 * of an organization asks about that organization's members only, in that
 * organization — `organization_id`, if given, must name it; a user who is not
 * a member, or does not exist, is the same 403. A client of no organization
 * must be a service's: it asks about global roles only and may not name an
 * organization, and a user that does not exist is a 403. Any other client (a login client) is refused, so that it
 * cannot learn any user's global permissions. Every refusal is 403, decided
 * before the user is looked up, so it reveals nothing about which users exist.
 * A deactivated user, or an inactive or archived organization, holds nothing,
 * as requireAuth would refuse their tokens.
 */
const permissionsInClientOrg = async (
  client: ClientRecord,
  body: { user_id: string; organization_id?: string }
): Promise<string[]> => {
  const clientOrg = client.organizationId;
  if (!clientOrg) {
    // Not an integration's: an external party learns no user's global permissions.
    if ((await db.services.getByClientId(client.id))?.kind !== "service") {
      throw new ForbiddenError(
        "Only a service's client or an organization's client may check permissions"
      );
    }
    if (body.organization_id) {
      throw new ForbiddenError(
        "This client belongs to no organization; it may ask about global permissions only"
      );
    }
    const user = await db.users.get(body.user_id).catch((err) => {
      if (err instanceof NotFoundError) {
        throw new ForbiddenError("The user does not exist");
      }
      throw err;
    });
    if (!user.isActive) return [];
    return db.roles.getUserPermissions(body.user_id);
  }
  if (body.organization_id && body.organization_id !== clientOrg) {
    throw new ForbiddenError(
      "This client may only ask about its own organization"
    );
  }
  const membership = await db.organizations.getMembership(
    clientOrg,
    body.user_id
  );
  if (!membership) {
    throw new ForbiddenError(
      "The user is not a member of this client's organization"
    );
  }
  if (!membership.user.isActive || !(await isActiveOrganization(clientOrg))) {
    return [];
  }
  return db.roles.getUserPermissions(body.user_id, clientOrg);
};

/** Only a confidential client, by HTTP Basic, may ask. */
const verifyClientCredentials = async (req: Request, res: Response) => {
  if (!parseBasicAuth(req)) throw clientAuthenticationFailed(res);
  const client = await authenticateClient(req, res, undefined);
  if (client.clientType === "public") throw clientAuthenticationFailed(res);
  return client;
};
