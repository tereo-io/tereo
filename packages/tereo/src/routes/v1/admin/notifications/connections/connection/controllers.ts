import type { NotificationConnection } from "../../../../../../../prisma/generated/client/index.js";
import { PermanentSendError } from "../../../../../../utils/notifications/channels/types.js";
import { getAdapter } from "../../../../../../utils/notifications/channels/index.js";
import { computeChanges, logAuditTx } from "../../../../../../utils/outbox.js";
import { prisma, type Prisma } from "../../../../../../utils/db/prisma.js";
import { validateUser } from "../../../../../../utils/auth.js";
import db from "../../../../../../utils/db/index.js";
import type { Request, Response } from "express";
import {
  auditView,
  formatConnection,
  lockChannel,
  parseWith,
  record,
  seal,
} from "../../../../../../utils/notifications/connectionAdmin.js";
import {
  openConnectionSecrets,
  toConnectionView,
} from "../../../../../../utils/notifications/connections.js";
import {
  validateBody,
  validateParams,
} from "../../../../../../utils/validateReq.js";
import {
  AppError,
  BadRequestError,
  ConflictError,
} from "../../../../../../utils/errors.js";
import {
  ConnectionIdParamSchema,
  TestConnectionSchema,
  UpdateConnectionSchema,
} from "./schemas.js";

const ENTITY_TYPE = "NotificationConnection";

export const getConnection = async (req: Request, res: Response) => {
  const { id } = validateParams(ConnectionIdParamSchema, req);
  res.json(formatConnection(await db.notificationConnections.get(id)));
};

export const updateConnection = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { id } = validateParams(ConnectionIdParamSchema, req);
  const body = validateBody(UpdateConnectionSchema, req);

  const existing = await db.notificationConnections.get(id);
  const adapter = getAdapter(existing.channel);
  const data: Prisma.NotificationConnectionUncheckedUpdateInput = {
    updatedBy: auth.userId,
  };
  if (body.displayName !== undefined) data.displayName = body.displayName;
  if (body.isEnabled !== undefined) data.isEnabled = body.isEnabled;
  if (body.maxPerMinute !== undefined) data.maxPerMinute = body.maxPerMinute;
  let settings: Record<string, unknown> | undefined;
  if (body.settings !== undefined) {
    settings = parseWith(
      adapter.settingsSchema,
      body.settings,
      "invalid_settings"
    ) as Record<string, unknown>;
    data.settings = settings as Prisma.InputJsonValue;
  }
  if (body.secrets === null) {
    data.secrets = null;
  } else if (body.secrets !== undefined) {
    data.secrets = await seal(
      id,
      parseWith(adapter.secretsSchema, body.secrets, "invalid_secrets")
    );
  }

  const updated = await db.$transaction(async (tx) => {
    // Compared under the row's lock: a concurrent update that stored secrets
    // or moved the server cannot slip between the check and the write.
    const before = await db.notificationConnections.getForUpdate(id, tx);
    if (settings !== undefined) {
      // Otherwise POST /test would send the stored password to the new server.
      const stored = before.settings as Record<string, unknown>;
      const redirected = adapter.secretBoundSettings.filter(
        (key) => settings[key] !== stored[key]
      );
      if (
        redirected.length > 0 &&
        before.secrets !== null &&
        body.secrets === undefined
      ) {
        throw new BadRequestError(
          "secrets_required",
          `Changing ${redirected.join(", ")} needs the secrets again in the same request`
        );
      }
    }
    const row = await db.notificationConnections.update(id, data, tx);
    const changes = computeChanges(auditView(before), auditView(row));
    // Secrets stay out of `changes`; the entry says only that they changed.
    await record(
      tx,
      auth,
      "UPDATE",
      row,
      changes,
      body.secrets === undefined
        ? undefined
        : body.secrets === null
          ? { secretsCleared: true }
          : { secretsChanged: true }
    );
    return row;
  });

  res.json(formatConnection(updated));
};

export const setDefaultConnection = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { id } = validateParams(ConnectionIdParamSchema, req);

  const result = await db.$transaction(async (tx) => {
    const target = await db.notificationConnections.get(id, tx);
    await lockChannel(tx, target.channel);
    const before = new Map<string, NotificationConnection>();
    const current = await db.notificationConnections.getDefault(
      target.channel,
      tx
    );
    for (const row of [target, current]) {
      if (row) before.set(row.id, row);
    }
    const changed = await db.notificationConnections.setDefault(id, tx);
    for (const row of changed) {
      await record(
        tx,
        auth,
        "UPDATE",
        row,
        computeChanges(auditView(before.get(row.id)!), auditView(row))
      );
    }
    return db.notificationConnections.get(id, tx);
  });

  res.json(formatConnection(result));
};

export const deleteConnection = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { id } = validateParams(ConnectionIdParamSchema, req);

  await db.$transaction(async (tx) => {
    const existing = await db.notificationConnections.get(id, tx);
    // Against a concurrent create or set-default changing which is default.
    await lockChannel(tx, existing.channel);
    if (
      existing.isDefault &&
      (await tx.notificationConnection.count({
        where: { channel: existing.channel, id: { not: id } },
      })) > 0
    ) {
      throw new ConflictError(
        "This is the channel's default connection; make another the default before deleting it",
        "connection_is_default"
      );
    }
    if (await db.notificationConnections.isReferenced(id, tx)) {
      throw new ConflictError(
        "Notifications were sent through this connection; disable it instead of deleting it",
        "connection_in_use"
      );
    }
    await db.notificationConnections.remove(id, tx);
    await record(tx, auth, "DELETE", existing);
  });

  res.status(204).end();
};

/**
 * What a failed test reports: the server's SMTP reply when there was one,
 * else an error code. Not the library's message, which can quote whatever a
 * non-SMTP service at that host and port answered.
 */
const describeTestFailure = (err: unknown): string => {
  if (err instanceof PermanentSendError) {
    return err.code === "smtp_rejected" ? err.message : err.code;
  }
  if (err instanceof AppError) return err.message;
  const e = err as {
    responseCode?: unknown;
    response?: unknown;
    code?: unknown;
  };
  if (typeof e?.responseCode === "number" && typeof e.response === "string") {
    return e.response.slice(0, 500);
  }
  return typeof e?.code === "string" ? e.code : "connection_failed";
};

/** Sends one message through the connection and reports the provider's answer. */
export const testConnection = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { id } = validateParams(ConnectionIdParamSchema, req);
  const { to } = validateBody(TestConnectionSchema, req);

  const connection = await db.notificationConnections.get(id);
  const adapter = getAdapter(connection.channel);

  let outcome:
    | { ok: true; providerResponse: string | null }
    | { ok: false; error: string };
  try {
    const secrets = await openConnectionSecrets(connection);
    const result = await adapter.test(
      toConnectionView(connection),
      secrets,
      to
    );
    outcome = { ok: true, providerResponse: result.providerResponse };
  } catch (err) {
    outcome = { ok: false, error: describeTestFailure(err) };
  }

  await prisma.$transaction((tx) =>
    logAuditTx(tx, {
      auth,
      action: "UPDATE",
      entityType: ENTITY_TYPE,
      entityId: connection.id,
      entityName: `${connection.channel}/${connection.slug}`,
      metadata: { operation: "test", to, ok: outcome.ok },
    })
  );

  res.json(outcome);
};
