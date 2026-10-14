import { getDefaultOrganizationId } from "../../../../utils/defaultOrganization.js";
import { validateBody, validateQuery } from "../../../../utils/validateReq.js";
import { CreateClientSchema, ListClientsQuerySchema } from "./schemas.js";
import { formatClient } from "../../../../utils/transformers.js";
import { emitTx, logAuditTx } from "../../../../utils/outbox.js";
import { validateUser } from "../../../../utils/auth.js";
import type { Request, Response } from "express";
import db from "../../../../utils/db/index.js";
import { verifyScopes } from "./utils.js";
import {
  applyCursorToWhere,
  buildCursorPageResponse,
} from "../../../../utils/cursor.js";
import {
  generateClientId,
  generateClientSecret,
} from "../../../../utils/crypto.js";

export const createClient = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const body = validateBody(CreateClientSchema, req);

  await verifyScopes(body.scopes);
  const clientId = generateClientId();

  const isPublic = body.clientType === "public";
  let plainSecret: string | undefined;
  let hashedSecret: string | null = null;

  if (!isPublic) {
    const secret = generateClientSecret();
    plainSecret = secret.plainSecret;
    hashedSecret = secret.hashedSecret;
  }

  const newClient = await db.$transaction(async (tx) => {
    const client = await db.clients.create(
      {
        ...body,
        clientId,
        clientSecret: hashedSecret,
        ownerId: auth.userId,
      },
      tx
    );

    const fullClient = await db.clients.get(client.id, tx);
    await logAuditTx(tx, {
      auth,
      action: "CREATE",
      entityType: "OAuthClient",
      entityId: fullClient.id,
      entityName: fullClient.name,
      metadata: {
        clientId: fullClient.clientId,
        clientType: fullClient.clientType,
        grantTypes: fullClient.grantTypes,
        scopes: fullClient.scopes,
      },
    });
    await emitTx(tx, {
      organizationId: getDefaultOrganizationId(),
      eventType: "auth.client.created",
      entityType: "OAuthClient",
      entityId: fullClient.id,
      data: formatClient(fullClient) as Record<string, unknown>,
    });
    return fullClient;
  });

  const created = await db.clients.getWithRelations(newClient.id);
  res.status(201).json(formatClient(created, !isPublic, plainSecret));
};

export const listClients = async (req: Request, res: Response) => {
  const query = validateQuery(ListClientsQuerySchema, req);

  const where = applyCursorToWhere(query);

  const result = await db.clients.getPaginated({
    take: query.limit,
    orderBy: query.orderBy,
    where,
  });

  const page = buildCursorPageResponse(result, query);
  res.json({ ...page, data: page.data.map((c) => formatClient(c)) });
};
