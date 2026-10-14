import { getDefaultOrganizationId } from "../../../../utils/defaultOrganization.js";
import { validateBody, validateQuery } from "../../../../utils/validateReq.js";
import { CreateUserSchema, ListUsersQuerySchema } from "./schemas.js";
import { emitTx, logAuditTx } from "../../../../utils/outbox.js";
import { formatUser } from "../../../../utils/transformers.js";
import { ConflictError } from "../../../../utils/errors.js";
import { validateUser } from "../../../../utils/auth.js";
import type { Request, Response } from "express";
import db from "../../../../utils/db/index.js";
import {
  applyCursorToWhere,
  buildCursorPageResponse,
} from "../../../../utils/cursor.js";

export const createUser = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const body = validateBody(CreateUserSchema, req);

  const existing = await db.users.getByEmail(body.email);
  if (existing) throw new ConflictError("User with this email already exists");

  const user = await db.$transaction(async (tx) => {
    const created = await db.users.create(body, tx);
    await logAuditTx(tx, {
      auth,
      action: "CREATE",
      entityType: "User",
      entityId: created.id,
      entityName: created.email,
      metadata: {
        email: created.email,
        name: created.name,
        userType: created.userType,
      },
    });
    await emitTx(tx, {
      organizationId: getDefaultOrganizationId(),
      eventType: "auth.user.created",
      entityType: "User",
      entityId: created.id,
      data: formatUser(created) as unknown as Record<string, unknown>,
    });
    return created;
  });

  res.status(201).json(formatUser(user));
};

export const listUsers = async (req: Request, res: Response) => {
  const query = validateQuery(ListUsersQuerySchema, req);

  const where = applyCursorToWhere(query);

  const result = await db.users.getPaginated({
    take: query.limit,
    orderBy: query.orderBy,
    where,
  });

  const page = buildCursorPageResponse(result, query);
  res.json({ ...page, data: page.data.map(formatUser) });
};
