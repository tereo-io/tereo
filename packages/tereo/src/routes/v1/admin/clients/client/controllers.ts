import { getDefaultOrganizationId } from "../../../../../utils/defaultOrganization.js";
import { disconnectTokenSockets } from "../../../../../websocket/emitters/index.js";
import { UserType } from "../../../../../../prisma/generated/client/index.js";
import { UpdateClientSchema, type UpdateClientInput } from "./schemas.js";
import { generateClientSecret } from "../../../../../utils/crypto.js";
import { formatClient } from "../../../../../utils/transformers.js";
import { hasPermission } from "../../../../../utils/permissions.js";
import { LOGIN_CLIENT } from "../../../../../definitions/index.js";
import { validateUser } from "../../../../../utils/auth.js";
import db from "../../../../../utils/db/index.js";
import type { Request, Response } from "express";
import { verifyScopes } from "../utils.js";
import {
  validateBody,
  validateParams,
} from "../../../../../utils/validateReq.js";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
} from "../../../../../utils/errors.js";
import {
  logAuditTx,
  computeChanges,
  emitTx,
} from "../../../../../utils/outbox.js";
import {
  ClientIdParamSchema,
  PUBLIC_CLIENT_ALLOWED_GRANTS,
} from "../schemas.js";

/** A service's client is managed with its service, under /admin/services. */
const refuseServiceClient = async (id: string) => {
  if (await db.services.getByClientId(id)) {
    throw new ConflictError(
      "This client belongs to a service; manage it under /admin/services"
    );
  }
};

/**
 * The admin UI's client type, grant types and redirect URIs follow from
 * UI_BASE_URL and are set at every start (`loginClientConfig`); an edit would
 * only lock the UI out until the next one.
 */
const refuseLockedLoginClientFields = (body: UpdateClientInput) => {
  const locked = (["redirectUris", "grantTypes", "clientType"] as const).filter(
    (field) => body[field] !== undefined
  );
  if (locked.length > 0) {
    throw new ConflictError(
      `The admin UI's login client derives ${locked.join(", ")} from UI_BASE_URL; they cannot be edited`
    );
  }
};

const assertOwnerOrAdmin = (
  ownerId: string,
  user: ReturnType<typeof validateUser>,
  action: string
) => {
  if (
    ownerId !== user.userId &&
    !hasPermission(user.permissions, "clients.admin")
  ) {
    throw new ForbiddenError(
      `Only the client's owner or a clients.admin can ${action} it`
    );
  }
};

export const getClient = async (req: Request, res: Response) => {
  const user = validateUser(req);
  const params = validateParams(ClientIdParamSchema, req);

  const client = await db.clients.getWithRelations(params.id);
  assertOwnerOrAdmin(client.ownerId, user, "view");
  res.json(formatClient(client));
};

export const updateClient = async (req: Request, res: Response) => {
  const user = validateUser(req);
  const params = validateParams(ClientIdParamSchema, req);
  await refuseServiceClient(params.id);
  const body = validateBody(UpdateClientSchema, req);

  const existingClient = await db.clients.get(params.id);
  assertOwnerOrAdmin(existingClient.ownerId, user, "update");
  if (existingClient.clientId === LOGIN_CLIENT.clientId) {
    refuseLockedLoginClientFields(body);
  }
  if (body.scopes) await verifyScopes(body.scopes);

  // Validate ownership transfer
  if (body.ownerId && body.ownerId !== existingClient.ownerId) {
    const newOwner = await db.users.getFromBody(body.ownerId);
    if (newOwner.userType !== UserType.human) {
      throw new BadRequestError(
        "invalid_owner",
        "Only human users can own OAuth clients. Service accounts cannot be owners."
      );
    }
    if (!newOwner.isActive) {
      throw new BadRequestError(
        "invalid_owner",
        "An inactive user cannot own an OAuth client"
      );
    }
  }

  const effectiveClientType = body.clientType ?? existingClient.clientType;
  // A confidential client authenticates with its secret, so one switched
  // from public without a secret gets one, returned once as on create.
  const secret =
    body.clientType === "confidential" &&
    existingClient.clientType !== "confidential" &&
    !existingClient.clientSecret
      ? generateClientSecret()
      : null;
  const effectiveGrantTypes = body.grantTypes ?? existingClient.grantTypes;
  const effectiveRedirectUris =
    body.redirectUris ?? existingClient.redirectUris;

  if (effectiveClientType === "public") {
    const invalidGrants = effectiveGrantTypes.filter(
      (gt) => !PUBLIC_CLIENT_ALLOWED_GRANTS.includes(gt)
    );
    if (invalidGrants.length > 0) {
      throw new BadRequestError(
        "invalid_request",
        "Public clients can only use authorization_code and refresh_token grant types"
      );
    }
    if (effectiveRedirectUris.length === 0) {
      throw new BadRequestError(
        "invalid_request",
        "Public clients must have at least one redirect URI"
      );
    }
  }

  const client = await db.$transaction(async (tx) => {
    const updated = await db.clients.update(
      {
        id: params.id,
        ...body,
        ...(secret && { clientSecret: secret.hashedSecret }),
      },
      tx
    );
    await logAuditTx(tx, {
      auth: user,
      action: "UPDATE",
      entityType: "OAuthClient",
      entityId: updated.id,
      entityName: updated.name,
      // Never the secret's hash; a generated secret is noted in metadata.
      changes: computeChanges(
        withoutSecret(existingClient),
        withoutSecret(updated)
      ),
      ...(secret && { metadata: { action: "secret_generated" } }),
    });
    await emitTx(tx, {
      organizationId: getDefaultOrganizationId(),
      eventType: "auth.client.updated",
      entityType: "OAuthClient",
      entityId: updated.id,
      data: formatClient(updated) as Record<string, unknown>,
    });
    return updated;
  });

  const full = await db.clients.getWithRelations(client.id);
  res.json(
    secret ? formatClient(full, true, secret.plainSecret) : formatClient(full)
  );
};

const withoutSecret = (client: object): Record<string, unknown> => {
  const { clientSecret: _secret, ...rest } = client as Record<string, unknown>;
  return rest;
};

export const deleteClient = async (req: Request, res: Response) => {
  const user = validateUser(req);
  const params = validateParams(ClientIdParamSchema, req);
  await refuseServiceClient(params.id);

  const existingClient = await db.clients.get(params.id);
  assertOwnerOrAdmin(existingClient.ownerId, user, "delete");
  // The admin UI signs in through it; without it nobody could.
  if (existingClient.clientId === LOGIN_CLIENT.clientId) {
    throw new ConflictError("The admin UI's login client cannot be deleted");
  }
  const jtis = await db.$transaction(async (tx) => {
    const jtis = await db.accessTokens.revokeByClientId(params.id, tx);
    // History names the client's service-account user, not the client, so
    // the user outlives it — deactivated, never deleted.
    const serviceAccount = await db.users.getByOAuthClientId(params.id);
    if (serviceAccount) {
      await db.users.update(serviceAccount.id, { isActive: false }, tx);
    }
    await db.clients.deleteClient(params.id, tx);
    await logAuditTx(tx, {
      auth: user,
      action: "DELETE",
      entityType: "OAuthClient",
      entityId: existingClient.id,
      entityName: existingClient.name,
      metadata: {
        clientId: existingClient.clientId,
        revokedAccessTokens: jtis.length,
        serviceAccountUserId: serviceAccount?.id ?? null,
      },
    });
    await emitTx(tx, {
      organizationId: getDefaultOrganizationId(),
      eventType: "auth.client.deleted",
      entityType: "OAuthClient",
      entityId: existingClient.id,
      data: {
        id: existingClient.id,
        clientId: existingClient.clientId,
        name: existingClient.name,
      },
    });
    return jtis;
  });
  disconnectTokenSockets(jtis);

  res.status(204).send();
};

export const regenerateClientSecret = async (req: Request, res: Response) => {
  const user = validateUser(req);
  const params = validateParams(ClientIdParamSchema, req);
  await refuseServiceClient(params.id);

  const client = await db.clients.get(params.id);
  assertOwnerOrAdmin(client.ownerId, user, "regenerate the secret of");
  if (client.clientType === "public") {
    throw new BadRequestError(
      "invalid_request",
      "Cannot regenerate secret for public clients"
    );
  }

  const { plainSecret, hashedSecret } = generateClientSecret();

  const updated = await db.$transaction(async (tx) => {
    const result = await db.clients.update(
      { id: params.id, clientSecret: hashedSecret },
      tx
    );
    await logAuditTx(tx, {
      auth: user,
      action: "UPDATE",
      entityType: "OAuthClient",
      entityId: result.id,
      entityName: result.name,
      metadata: {
        clientId: result.clientId,
        action: "secret_regenerated",
      },
    });
    await emitTx(tx, {
      organizationId: getDefaultOrganizationId(),
      eventType: "auth.client.secret-regenerated",
      entityType: "OAuthClient",
      entityId: result.id,
      data: { id: result.id, clientId: result.clientId, name: result.name },
    });
    return result;
  });

  const full = await db.clients.getWithRelations(updated.id);
  res.json(formatClient(full, true, plainSecret));
};
