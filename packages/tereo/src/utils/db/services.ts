import { NotFoundError } from "../errors.js";
import { userRefSelect } from "../refs.js";
import type { Prisma } from "./prisma.js";
import { prisma } from "./prisma.js";

const withClient = {
  client: {
    select: {
      id: true,
      clientId: true,
      audience: true,
      previousSecretExpiresAt: true,
      serviceAccountUser: {
        select: { id: true, email: true, name: true, isActive: true },
      },
    },
  },
  creator: userRefSelect,
} satisfies Prisma.ServiceInclude;

export const get = async (
  id: string,
  tx: Prisma.TransactionClient = prisma
) => {
  const service = await tx.service.findUnique({
    where: { id },
    include: withClient,
  });
  if (!service) throw new NotFoundError("Service not found");
  return service;
};

/** The ones of these slugs that name a service. */
export const findSlugs = async (
  slugs: string[],
  tx: Prisma.TransactionClient = prisma
): Promise<Set<string>> => {
  const found = await tx.service.findMany({
    where: { slug: { in: slugs } },
    select: { slug: true },
  });
  return new Set(found.map((s) => s.slug));
};

/** The service an OAuth client (by row id) belongs to, if any. */
export const getByClientId = (clientId: string) =>
  prisma.service.findUnique({ where: { clientId } });

interface PageOptions {
  take: number;
  orderBy?: Record<string, "asc" | "desc">[];
  where?: Record<string, unknown>;
}

export const getPaginated = async (options: PageOptions) => {
  const rows = await prisma.service.findMany({
    take: options.take + 1,
    orderBy: options.orderBy,
    where: options.where,
    include: withClient,
  });
  const hasMore = rows.length > options.take;
  return { data: hasMore ? rows.slice(0, options.take) : rows, hasMore };
};

/** Access rows across every service, each with the service it belongs to. */
export const getAccessPaginated = async (options: PageOptions) => {
  const rows = await prisma.serviceAccess.findMany({
    take: options.take + 1,
    orderBy: options.orderBy,
    where: options.where,
    include: { service: { select: { id: true, slug: true, name: true } } },
  });
  const hasMore = rows.length > options.take;
  return { data: hasMore ? rows.slice(0, options.take) : rows, hasMore };
};

export type ServiceWithClient = Awaited<ReturnType<typeof get>>;
