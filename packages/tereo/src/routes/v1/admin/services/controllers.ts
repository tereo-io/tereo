import { validateBody, validateQuery } from "../../../../utils/validateReq.js";
import { withDeciders } from "../../../../utils/serviceAccess.js";
import { formatService } from "../../../../utils/transformers.js";
import { createServiceTx } from "../../../../utils/services.js";
import { BadRequestError } from "../../../../utils/errors.js";
import { validateUser } from "../../../../utils/auth.js";
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
  CreateServiceSchema,
  ListServiceAccessQuerySchema,
  ListServicesQuerySchema,
} from "./schemas.js";

const slugify = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^a-z]+/, "")
    // slug and namespace are VarChar(64).
    .slice(0, 64)
    .replace(/-+$/, "");

/**
 * Add a service: its confidential client (client_credentials only), the
 * service-account user it acts as, and its row. The secret is in this
 * response and nowhere else — only its hash is stored.
 */
export const createService = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const body = validateBody(CreateServiceSchema, req);

  const slug = body.slug ?? slugify(body.name);
  if (!slug) {
    throw new BadRequestError(
      "invalid_name",
      "Name has no letters to derive a slug from"
    );
  }
  const namespace = body.namespace ?? slug.replace(/-service$/, "");

  const clientId = generateClientId();
  const { plainSecret, hashedSecret } = generateClientSecret();

  const service = await db.$transaction((tx) =>
    createServiceTx(
      tx,
      {
        slug,
        name: body.name,
        namespace,
        clientId,
        clientSecretHash: hashedSecret,
      },
      auth
    )
  );

  res.status(201).json({
    ...formatService(service),
    credentials: { clientId, clientSecret: plainSecret },
  });
};

export const listServices = async (req: Request, res: Response) => {
  const query = validateQuery(ListServicesQuerySchema, req);
  const result = await db.services.getPaginated({
    take: query.limit,
    orderBy: query.orderBy,
    where: applyCursorToWhere(query),
  });
  const page = buildCursorPageResponse(result, query);
  res.json({
    ...page,
    data: page.data.map(formatService),
  });
};

/** Access rows across every service. */
export const listServiceAccess = async (req: Request, res: Response) => {
  const query = validateQuery(ListServiceAccessQuerySchema, req);
  const result = await db.services.getAccessPaginated({
    take: query.limit,
    orderBy: query.orderBy,
    where: applyCursorToWhere(query),
  });
  const page = buildCursorPageResponse(result, query);
  res.json({ ...page, data: await withDeciders(page.data) });
};
