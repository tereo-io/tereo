import { getAdapter } from "../../../../../utils/notifications/channels/index.js";
import type { Prisma } from "../../../../../utils/db/prisma.js";
import { ConflictError } from "../../../../../utils/errors.js";
import { validateUser } from "../../../../../utils/auth.js";
import db from "../../../../../utils/db/index.js";
import type { Request, Response } from "express";
import {
  formatConnection,
  lockChannel,
  parseWith,
  record,
  seal,
} from "../../../../../utils/notifications/connectionAdmin.js";
import {
  validateBody,
  validateQuery,
} from "../../../../../utils/validateReq.js";
import {
  CreateConnectionSchema,
  ListConnectionsQuerySchema,
} from "./schemas.js";

export const listConnections = async (req: Request, res: Response) => {
  const query = validateQuery(ListConnectionsQuerySchema, req);
  const rows = await db.notificationConnections.list(query);
  res.json({ data: rows.map(formatConnection) });
};

export const createConnection = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const body = validateBody(CreateConnectionSchema, req);
  const adapter = getAdapter(body.channel);
  const settings = parseWith(
    adapter.settingsSchema,
    body.settings,
    "invalid_settings"
  );
  const secrets =
    body.secrets === undefined
      ? undefined
      : parseWith(adapter.secretsSchema, body.secrets, "invalid_secrets");

  const created = await db.$transaction(async (tx) => {
    await lockChannel(tx, body.channel);
    if (
      await db.notificationConnections.getBySlug(body.channel, body.slug, tx)
    ) {
      throw new ConflictError(
        `A ${body.channel} connection with slug "${body.slug}" already exists`,
        "slug_taken"
      );
    }
    const hasDefault = await db.notificationConnections.getDefault(
      body.channel,
      tx
    );
    let row = await db.notificationConnections.create(
      {
        channel: body.channel,
        slug: body.slug,
        displayName: body.displayName,
        settings: settings as Prisma.InputJsonValue,
        isDefault: !hasDefault,
        isEnabled: body.isEnabled ?? true,
        maxPerMinute: body.maxPerMinute ?? null,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      },
      tx
    );
    if (secrets !== undefined) {
      // The sealed value is bound to the row id, which exists only now.
      row = await db.notificationConnections.update(
        row.id,
        { secrets: await seal(row.id, secrets) },
        tx
      );
    }
    await record(tx, auth, "CREATE", row);
    return row;
  });

  res.status(201).json(formatConnection(created));
};
