import { getDefaultOrganizationId } from "../../../../utils/defaultOrganization.js";
import { validateBody, validateQuery } from "../../../../utils/validateReq.js";
import { BadRequestError, ConflictError } from "../../../../utils/errors.js";
import { UserType } from "../../../../../prisma/generated/client/index.js";
import { assertNamespaceAvailable } from "../../../../utils/registry.js";
import { withDeciders } from "../../../../utils/serviceAccess.js";
import { formatService } from "../../../../utils/transformers.js";
import { emitTx, logAuditTx } from "../../../../utils/outbox.js";
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

  const service = await db.$transaction(async (tx) => {
    if (await tx.service.findUnique({ where: { slug } })) {
      throw new ConflictError(`A service with slug "${slug}" already exists`);
    }
    await assertNamespaceAvailable(namespace, tx);
    const email = `${slug}@services.tereo.internal`;
    if (await tx.user.findUnique({ where: { email } })) {
      throw new ConflictError(`A user with email "${email}" already exists`);
    }

    const client = await tx.oAuthClient.create({
      data: {
        clientId,
        clientSecret: hashedSecret,
        clientType: "confidential",
        name: body.name,
        redirectUris: [],
        scopes: [],
        grantTypes: ["client_credentials"],
        audience: [],
        ownerId: auth.userId,
      },
    });
    await tx.user.create({
      data: {
        email,
        name: body.name,
        passwordHash: "!",
        userType: UserType.service_account,
        oauthClientId: client.id,
      },
    });
    const created = await tx.service.create({
      data: {
        slug,
        name: body.name,
        namespace,
        clientId: client.id,
        createdBy: auth.userId,
      },
    });

    await logAuditTx(tx, {
      auth,
      action: "CREATE",
      entityType: "Service",
      entityId: created.id,
      entityName: slug,
      metadata: { name: body.name, namespace, clientId },
    });
    await emitTx(tx, {
      organizationId: getDefaultOrganizationId(),
      eventType: "core.service.created",
      entityType: "Service",
      entityId: created.id,
      data: { id: created.id, slug, name: body.name, namespace },
    });
    return db.services.get(created.id, tx);
  });

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
    data: page.data.map(({ _count, ...service }) => ({
      ...formatService(service),
      pendingAccessCount: _count.access,
    })),
  });
};

/** Access requests across every service — the approval inbox. */
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
