import { Prisma } from "../../../prisma/generated/client/index.js";
import { GetPaginatedOptions } from "./types.js";
import { NotFoundError } from "../errors.js";
import { prisma } from "./prisma.js";

// Event types are written only by the registry (utils/registry.ts).

const withService = {
  service: { select: { name: true } },
} satisfies Prisma.EventTypeInclude;

type EventTypeWithService = Prisma.EventTypeGetPayload<{
  include: typeof withService;
}>;

const withServiceName = ({ service, ...et }: EventTypeWithService) => ({
  ...et,
  serviceName: service.name,
});

export const getByEventType = async (eventType: string) => {
  const et = await prisma.eventType.findUnique({
    where: { eventType },
    include: withService,
  });
  if (!et) throw new NotFoundError("Event type not found");
  return withServiceName(et);
};

export const getPaginated = async (options: GetPaginatedOptions) => {
  const { take, orderBy, where: filterWhere } = options;
  const where = filterWhere ?? {};

  const rows = await prisma.eventType.findMany({
    where,
    take: take + 1,
    orderBy,
    include: withService,
  });

  const hasMore = rows.length > take;
  const data = (hasMore ? rows.slice(0, take) : rows).map(withServiceName);

  return { data, hasMore };
};

/** Those of `eventTypes` that exist and are not retired — subscribable. */
export const findMany = async (eventTypes: string[]) => {
  return await prisma.eventType.findMany({
    where: { eventType: { in: eventTypes }, retiredAt: null },
    select: { eventType: true, readPermission: true },
  });
};

/** Each of `eventTypes`' read permission, retired ones included. */
export const readPermissions = async (
  eventTypes: string[]
): Promise<Map<string, string | null>> => {
  const rows = await prisma.eventType.findMany({
    where: { eventType: { in: [...new Set(eventTypes)] } },
    select: { eventType: true, readPermission: true },
  });
  return new Map(rows.map((r) => [r.eventType, r.readPermission]));
};
