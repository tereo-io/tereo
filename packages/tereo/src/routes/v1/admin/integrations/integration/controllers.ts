import { getDefaultOrganizationId } from "../../../../../utils/defaultOrganization.js";
import { formatIntegration } from "../../../../../utils/transformers.js";
import { generateClientSecret } from "../../../../../utils/crypto.js";
import { emitTx, logAuditTx } from "../../../../../utils/outbox.js";
import { assertMayChangeAudience } from "../../clients/utils.js";
import { validateUser } from "../../../../../utils/auth.js";
import db from "../../../../../utils/db/index.js";
import type { Request, Response } from "express";
import {
  integrationRef,
  setIntegrationAudiencesTx,
  setIntegrationRolesTx,
  updateIntegrationTx,
} from "../../../../../utils/integrations.js";
import {
  validateBody,
  validateParams,
} from "../../../../../utils/validateReq.js";
import {
  revokePreviousSecretTx,
  rotatedSecretFields,
} from "../../../../../utils/clients.js";
import {
  ManagedByProvisioningError,
  NotFoundError,
} from "../../../../../utils/errors.js";
import {
  IntegrationIdParamSchema,
  SetIntegrationAudiencesSchema,
  SetIntegrationRolesSchema,
  UpdateIntegrationSchema,
} from "./schemas.js";

const getRow = (req: Request) =>
  db.services.getIntegration(validateParams(IntegrationIdParamSchema, req).id);

/** A provisioned integration changes only through the provisioning file. */
const getEditable = async (req: Request) => {
  const row = await getRow(req);
  if (row.provisioned) throw new ManagedByProvisioningError();
  return integrationRef(row);
};

export const getIntegration = async (req: Request, res: Response) => {
  res.json(formatIntegration(await getRow(req)));
};

/** Rename, deactivate or reactivate. A deactivated integration's tokens stop. */
export const updateIntegration = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const body = validateBody(UpdateIntegrationSchema, req);
  const existing = await getEditable(req);

  const updated = await db.$transaction((tx) =>
    updateIntegrationTx(tx, existing, body, auth)
  );
  res.json(formatIntegration(updated));
};

/**
 * Its roles, replaced: org roles in its organization when org-bound, global
 * roles otherwise. The caller must hold what is newly granted.
 */
export const setRoles = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { roleIds } = validateBody(SetIntegrationRolesSchema, req);
  const existing = await getEditable(req);

  const updated = await db.$transaction(async (tx) => {
    await setIntegrationRolesTx(tx, existing, roleIds, auth);
    return db.services.getIntegration(existing.id, tx);
  });
  res.json(formatIntegration(updated));
};

/**
 * The services that may introspect its tokens: naming one lets it read them,
 * so services.approve, as for a client's audience.
 */
export const setAudiences = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  assertMayChangeAudience(auth);
  const { slugs } = validateBody(SetIntegrationAudiencesSchema, req);
  const existing = await getEditable(req);

  const updated = await db.$transaction(async (tx) => {
    await setIntegrationAudiencesTx(tx, existing, slugs, auth);
    return db.services.getIntegration(existing.id, tx);
  });
  res.json(formatIntegration(updated));
};

/**
 * A new secret, shown once. The replaced one keeps working for
 * `SERVICE_SECRET_OVERLAP_HOURS`, as for services.
 */
export const regenerateSecret = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const integration = await getEditable(req);
  const { plainSecret, hashedSecret } = generateClientSecret();

  const { clientId, previousSecretExpiresAt } = await db.$transaction(
    async (tx) => {
      // Locked: two regenerations at once would each keep the secret they
      // read as the previous one, and the first one's new secret would be lost.
      const [client] = await tx.$queryRaw<
        {
          client_id: string;
          client_secret: string | null;
          previous_secret_hash: string | null;
          retired_secret_hashes: string[];
        }[]
      >`
        SELECT "client_id", "client_secret", "previous_secret_hash",
          "retired_secret_hashes"
        FROM "auth"."oauth_clients"
        WHERE "id" = ${integration.clientRowId}::uuid
        FOR UPDATE`;
      if (!client) throw new NotFoundError("Client not found");
      const data = rotatedSecretFields(
        {
          clientSecret: client.client_secret,
          previousSecretHash: client.previous_secret_hash,
          retiredSecretHashes: client.retired_secret_hashes,
        },
        hashedSecret,
        new Date()
      );
      const { previousSecretExpiresAt } = data;
      await tx.oAuthClient.update({
        where: { id: integration.clientRowId },
        data,
      });
      await logAuditTx(tx, {
        auth,
        action: "UPDATE",
        entityType: "Integration",
        entityId: integration.id,
        entityName: integration.slug,
        metadata: { action: "secret_regenerated", previousSecretExpiresAt },
      });
      await emitTx(tx, {
        organizationId: getDefaultOrganizationId(),
        eventType: "core.integration.secret-regenerated",
        entityType: "Integration",
        entityId: integration.id,
        data: {
          id: integration.id,
          slug: integration.slug,
          previousSecretExpiresAt,
        },
      });
      return { clientId: client.client_id, previousSecretExpiresAt };
    }
  );

  res.json({ clientId, clientSecret: plainSecret, previousSecretExpiresAt });
};

/**
 * End the overlap now. Allowed on a provisioned integration too: the file
 * cannot express it, and a leaked old secret must not wait out the overlap.
 */
export const revokePreviousSecret = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const integration = integrationRef(await getRow(req));

  const updated = await db.$transaction(async (tx) => {
    await revokePreviousSecretTx(tx, integration.clientRowId);
    await logAuditTx(tx, {
      auth,
      action: "UPDATE",
      entityType: "Integration",
      entityId: integration.id,
      entityName: integration.slug,
      metadata: { action: "previous_secret_revoked" },
    });
    await emitTx(tx, {
      organizationId: getDefaultOrganizationId(),
      eventType: "core.integration.previous-secret-revoked",
      entityType: "Integration",
      entityId: integration.id,
      data: { id: integration.id, slug: integration.slug },
    });
    return db.services.getIntegration(integration.id, tx);
  });

  res.json(formatIntegration(updated));
};
