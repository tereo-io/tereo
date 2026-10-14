import type { NotificationChannel } from "../../../prisma/generated/client/index.js";
import { NotFoundError } from "../errors.js";
import type { Prisma } from "./prisma.js";
import { prisma } from "./prisma.js";

type Tx = Prisma.TransactionClient;

export const list = (filter: { channel?: NotificationChannel } = {}) =>
  prisma.notificationConnection.findMany({
    where: filter.channel ? { channel: filter.channel } : undefined,
    orderBy: [{ channel: "asc" }, { slug: "asc" }],
  });

export const get = async (id: string, tx: Tx = prisma) => {
  const connection = await tx.notificationConnection.findUnique({
    where: { id },
  });
  if (!connection) throw new NotFoundError("Notification connection not found");
  return connection;
};

/** `get`, holding the row's lock until the transaction ends. */
export const getForUpdate = async (id: string, tx: Tx) => {
  await tx.$queryRaw`
    SELECT 1 FROM "notifications"."connections"
    WHERE "id" = ${id}::uuid FOR UPDATE`;
  return await get(id, tx);
};

export const getBySlug = (
  channel: NotificationChannel,
  slug: string,
  tx: Tx = prisma
) =>
  tx.notificationConnection.findUnique({
    where: { channel_slug: { channel, slug } },
  });

export const getDefault = (channel: NotificationChannel, tx: Tx = prisma) =>
  tx.notificationConnection.findFirst({ where: { channel, isDefault: true } });

export const create = (
  data: Prisma.NotificationConnectionUncheckedCreateInput,
  tx: Tx = prisma
) => tx.notificationConnection.create({ data });

export const update = (
  id: string,
  data: Prisma.NotificationConnectionUncheckedUpdateInput,
  tx: Tx = prisma
) => tx.notificationConnection.update({ where: { id }, data });

/**
 * Make the connection its channel's only default. The old default is cleared
 * first because the unique index on default connections is not deferred.
 * Returns the connections whose flag changed, the new default last.
 */
export const setDefault = async (id: string, tx: Tx) => {
  const connection = await get(id, tx);
  if (connection.isDefault) return [];
  const previous = await getDefault(connection.channel, tx);
  const changed = [];
  if (previous) {
    changed.push(await update(previous.id, { isDefault: false }, tx));
  }
  changed.push(await update(id, { isDefault: true }, tx));
  return changed;
};

export const remove = (id: string, tx: Tx = prisma) =>
  tx.notificationConnection.delete({ where: { id } });

/** Whether any notification or delivery was sent, or is queued, through it. */
export const isReferenced = async (id: string, tx: Tx = prisma) => {
  const [notification, delivery] = await Promise.all([
    tx.notification.findFirst({
      where: { connectionId: id },
      select: { id: true },
    }),
    tx.notificationDelivery.findFirst({
      where: { connectionId: id },
      select: { id: true },
    }),
  ]);
  return notification !== null || delivery !== null;
};
