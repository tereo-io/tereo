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
import {
  validateBody,
  validateParams,
} from "../../../../../utils/validateReq.js";
import {
  deleteLoginClientTx,
  withRetired,
} from "../../../../../utils/clients.js";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  ManagedByProvisioningError,
  NotFoundError,
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
import {
  assertMayChangeAudience,
  verifyAudience,
  verifyScopes,
} from "../utils.js";

/**
 * A service's or an integration's client is managed with it, under
 * /admin/services or /admin/integrations.
 */
const refuseServiceClient = async (id: string) => {
  const owner = await db.services.getByClientId(id);
  if (owner) {
    throw new ConflictError(
      owner.kind === "integration"
        ? "This client belongs to an integration; manage it under /admin/integrations"
        : "This client belongs to a service; manage it under /admin/services"
    );
  }
};

const refuseProvisioned = (client: { provisioned: boolean }) => {
  if (client.provisioned) throw new ManagedByProvisioningError();
};

/**
 * The admin UI's client type, grant types and redirect URIs follow from
 * UI_BASE_URL and are set at every start (`loginClientConfig`); an edit would
 * only lock the UI out until the next one. Consent is always skipped for it
 * and its audience comes from its scopes, so those two have no effect.
 */
const refuseLockedLoginClientFields = (body: UpdateClientInput) => {
  const locked = (
    [
      "redirectUris",
      "grantTypes",
      "clientType",
      "consentRequired",
      "audience",
    ] as const
  ).filter((field) => body[field] !== undefined);
  if (locked.length > 0) {
    throw new ConflictError(
      `The admin UI's login client fixes ${locked.join(", ")}; they cannot be edited`
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
  refuseProvisioned(existingClient);
  if (existingClient.clientId === LOGIN_CLIENT.clientId) {
    refuseLockedLoginClientFields(body);
  }
  if (body.scopes) await verifyScopes(body.scopes);
  const audience = body.audience && (await verifyAudience(body.audience));
  if (
    audience &&
    audience.join("\n") !== [...existingClient.audience].sort().join("\n")
  ) {
    assertMayChangeAudience(user);
  }

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
        audience,
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
  refuseProvisioned(existingClient);
  // The admin UI signs in through it; without it nobody could.
  if (existingClient.clientId === LOGIN_CLIENT.clientId) {
    throw new ConflictError("The admin UI's login client cannot be deleted");
  }
  const jtis = await db.$transaction((tx) =>
    deleteLoginClientTx(tx, existingClient, user)
  );
  disconnectTokenSockets(jtis);

  res.status(204).send();
};

export const regenerateClientSecret = async (req: Request, res: Response) => {
  const user = validateUser(req);
  const params = validateParams(ClientIdParamSchema, req);
  await refuseServiceClient(params.id);

  const client = await db.clients.get(params.id);
  assertOwnerOrAdmin(client.ownerId, user, "regenerate the secret of");
  refuseProvisioned(client);
  if (client.clientType === "public") {
    throw new BadRequestError(
      "invalid_request",
      "Cannot regenerate secret for public clients"
    );
  }

  const { plainSecret, hashedSecret } = generateClientSecret();

  const updated = await db.$transaction(async (tx) => {
    // Locked, so a concurrent regeneration's secret is retired too.
    const [current] = await tx.$queryRaw<
      { client_secret: string | null; retired_secret_hashes: string[] }[]
    >`
      SELECT "client_secret", "retired_secret_hashes"
      FROM "auth"."oauth_clients"
      WHERE "id" = ${params.id}::uuid
      FOR UPDATE`;
    if (!current) throw new NotFoundError("Client not found");
    const result = await db.clients.update(
      {
        id: params.id,
        clientSecret: hashedSecret,
        retiredSecretHashes: withRetired(
          current.retired_secret_hashes,
          current.client_secret
        ),
      },
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
