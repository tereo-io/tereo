import { NotFoundError } from "../errors.js";
import { prisma } from "./prisma.js";

// Permissions are written only by the registry (utils/registry.ts). These
// are the reads the admin API and role editing need.

const withService = { service: { select: { name: true } } } as const;

const flattenService = <T extends { service: { name: string } }>({
  service,
  ...permission
}: T) => ({ ...permission, serviceName: service.name });

/** Any permission, retired included — retired ones stay on custom roles. */
export const get = async (id: string) => {
  const res = await prisma.permission.findUnique({
    where: { id },
    include: withService,
  });
  if (!res) throw new NotFoundError("Permission not found");
  return flattenService(res);
};

interface GetPaginatedOptions {
  /** Over-fetch happens inside the helper — pass the user's requested page size. */
  take: number;
  orderBy?: Record<string, "asc" | "desc">[];
  where?: Record<string, unknown>;
  /** Include retired rows (default false). */
  includeRetired?: boolean;
}

export const getPaginated = async (options: GetPaginatedOptions) => {
  const { take, orderBy, where, includeRetired } = options;

  // The retirement guard spreads LAST so no caller-supplied filter can
  // override it.
  const whereClause = {
    ...where,
    ...(includeRetired ? {} : { retiredAt: null }),
  };

  const rows = await prisma.permission.findMany({
    take: take + 1,
    orderBy: orderBy as Record<string, "asc" | "desc">[],
    where: whereClause,
    include: withService,
  });

  const hasMore = rows.length > take;
  const data = (hasMore ? rows.slice(0, take) : rows).map(flattenService);

  return { data, hasMore };
};

/** Active (not retired) permissions among `ids`. */
export const getByIds = async (ids: string[]) => {
  return await prisma.permission.findMany({
    where: { id: { in: ids }, retiredAt: null },
  });
};
