import { validateBody, validateQuery } from "../../../../utils/validateReq.js";
import { createIntegrationTx } from "../../../../utils/integrations.js";
import { formatIntegration } from "../../../../utils/transformers.js";
import { BadRequestError } from "../../../../utils/errors.js";
import { validateUser } from "../../../../utils/auth.js";
import { slugify } from "../../../../utils/services.js";
import type { Request, Response } from "express";
import db from "../../../../utils/db/index.js";
import {
  applyCursorToWhere,
  buildCursorPageResponse,
} from "../../../../utils/cursor.js";
import {
  generateClientId,
  generateClientSecret,
} from "../../../../utils/crypto.js";
import {
  CreateIntegrationSchema,
  ListIntegrationsQuerySchema,
} from "./schemas.js";

/**
 * Add an integration, org-bound when `organizationId` is given. The secret is
 * in this response and nowhere else — only its hash is stored.
 */
export const createIntegration = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const body = validateBody(CreateIntegrationSchema, req);

  const slug = body.slug ?? slugify(body.name);
  if (!slug) {
    throw new BadRequestError(
      "invalid_name",
      "Name has no letters to derive a slug from"
    );
  }

  const clientId = generateClientId();
  const { plainSecret, hashedSecret } = generateClientSecret();

  const integration = await db.$transaction((tx) =>
    createIntegrationTx(
      tx,
      {
        slug,
        name: body.name,
        organizationId: body.organizationId ?? null,
        clientId,
        clientSecretHash: hashedSecret,
      },
      auth
    )
  );

  res.status(201).json({
    ...formatIntegration(integration),
    credentials: { clientId, clientSecret: plainSecret },
  });
};

export const listIntegrations = async (req: Request, res: Response) => {
  const query = validateQuery(ListIntegrationsQuerySchema, req);
  const result = await db.services.getIntegrationsPaginated({
    take: query.limit,
    orderBy: query.orderBy,
    where: applyCursorToWhere(query),
  });
  const page = buildCursorPageResponse(result, query);
  res.json({ ...page, data: page.data.map(formatIntegration) });
};
