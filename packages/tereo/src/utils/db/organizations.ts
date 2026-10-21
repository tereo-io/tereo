import { replaceAssignments } from "./roles.js";
import { prisma } from "./prisma.js";
import {
  OrgMemberRole,
  Prisma,
} from "../../../prisma/generated/client/index.js";
import {
  AlreadyArchivedError,
  ArchivedError,
  BadRequestError,
  ConflictError,
  NotArchivedError,
  NotFoundError,
} from "../errors.js";

export interface CreateOrganizationInput {
  id?: string;
  name: string;
  slug: string;
  code: string;
  isDefault?: boolean;
}

export interface UpdateOrganizationInput {
  name?: string;
  slug?: string;
  isActive?: boolean;
}

interface GetPaginatedOptions {
  /** Over-fetch happens inside the helper — pass the user's requested page size. */
  take: number;
  orderBy?: Record<string, "asc" | "desc">[];
  where?: Record<string, unknown>;
  /** Include archived rows (default false). Admin listing only. */
  includeArchived?: boolean;
}

/**
 * Operational lookup — archived organizations are invisible here, exactly
 * as soft-deleted ones were before the rename. Admin/restore paths that
 * must see archived rows use `getAny`.
 */
export const get = async (id: string, tx?: Prisma.TransactionClient) => {
  const db = tx ?? prisma;
  const res = await db.organization.findUnique({
    where: { id, archivedAt: null },
    include: { _count: { select: { members: true } } },
  });
  if (!res) throw new NotFoundError("Organization not found");
  return res;
};

/** Admin lookup that also returns archived organizations. */
export const getAny = async (id: string, tx?: Prisma.TransactionClient) => {
  const db = tx ?? prisma;
  const res = await db.organization.findUnique({
    where: { id },
    include: { _count: { select: { members: true } } },
  });
  if (!res) throw new NotFoundError("Organization not found");
  return res;
};

export const getDefault = async () => {
  return await prisma.organization.findFirst({
    where: { isDefault: true, archivedAt: null },
    include: { _count: { select: { members: true } } },
  });
};

/**
 * Any-state slug lookup for duplicate checks — the unique index spans
 * archived rows, so creates/renames must see them or they 500 on P2002.
 */
export const getBySlugAny = async (slug: string) => {
  return await prisma.organization.findFirst({ where: { slug } });
};

/** Any-state code lookup for duplicate checks — `code` is unique too. */
export const getByCodeAny = async (code: string) => {
  return await prisma.organization.findFirst({ where: { code } });
};

export const getPaginated = async (options: GetPaginatedOptions) => {
  const { take, orderBy, where, includeArchived } = options;

  // The archive guard spreads LAST so no caller-supplied filter can
  // override it.
  const whereClause = {
    ...where,
    ...(includeArchived ? {} : { archivedAt: null }),
  };

  const rows = await prisma.organization.findMany({
    take: take + 1,
    orderBy: orderBy as Record<string, "asc" | "desc">[],
    where: whereClause,
    include: { _count: { select: { members: true } } },
  });

  const hasMore = rows.length > take;
  const data = hasMore ? rows.slice(0, take) : rows;

  return { data, hasMore };
};

export const create = async (
  data: CreateOrganizationInput,
  tx?: Prisma.TransactionClient
) => {
  const db = tx ?? prisma;
  return await db.organization.create({
    data: {
      ...(data.id ? { id: data.id } : {}),
      name: data.name,
      slug: data.slug,
      code: data.code,
      isDefault: data.isDefault ?? false,
    },
    include: { _count: { select: { members: true } } },
  });
};

export const update = async (
  id: string,
  data: UpdateOrganizationInput,
  tx?: Prisma.TransactionClient
) => {
  const db = tx ?? prisma;
  // Callers check the organization is not archived before this; the WHERE repeats
  // it so an archive committing in between leaves no archived organization
  // reactivated. Losing that race answers as guardArchived would have.
  const result = await db.organization.updateMany({
    where: { id, archivedAt: null },
    data,
  });
  if (result.count === 0) {
    if (await db.organization.findUnique({ where: { id } })) {
      throw new ArchivedError();
    }
    throw new NotFoundError("Organization not found");
  }
  return await db.organization.findUniqueOrThrow({
    where: { id },
    include: { _count: { select: { members: true } } },
  });
};

export const archive = async (id: string, tx?: Prisma.TransactionClient) => {
  const db = tx ?? prisma;
  const existing = await db.organization.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Organization not found");
  if (existing.archivedAt) {
    throw new AlreadyArchivedError("Organization is already archived");
  }
  if (existing.isDefault) {
    throw new BadRequestError(
      "default_organization",
      "The default organization cannot be archived"
    );
  }
  if (existing.isActive) {
    throw new ConflictError(
      "Organization must be deactivated before it can be archived"
    );
  }
  // Re-assert the gate in the WHERE so a concurrent reactivate/archive can't
  // slip through between the read above and this write; 0 rows means the race
  // was lost.
  const result = await db.organization.updateMany({
    where: { id, archivedAt: null, isActive: false, isDefault: false },
    data: { archivedAt: new Date() },
  });
  if (result.count === 0) {
    throw new ConflictError(
      "Organization must be deactivated before it can be archived"
    );
  }
  return await db.organization.findUniqueOrThrow({
    where: { id },
    include: { _count: { select: { members: true } } },
  });
};

export const restore = async (id: string, tx?: Prisma.TransactionClient) => {
  const db = tx ?? prisma;
  const existing = await db.organization.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Organization not found");
  if (!existing.archivedAt) {
    throw new NotArchivedError("Organization is not archived");
  }
  // Restored organizations come back deactivated — reactivation is a
  // separate, explicit step (PATCH isActive) so no tokens spring back.
  return await db.organization.update({
    where: { id },
    data: { archivedAt: null },
    include: { _count: { select: { members: true } } },
  });
};

export const getMembers = async (orgId: string) => {
  return await prisma.organizationMember.findMany({
    where: { organizationId: orgId },
    include: {
      user: { select: { id: true, email: true, name: true, isActive: true } },
    },
    orderBy: { user: { email: "asc" } },
  });
};

export const getMembership = async (
  orgId: string,
  userId: string,
  tx?: Prisma.TransactionClient
) => {
  return await (tx ?? prisma).organizationMember.findUnique({
    where: { organizationId_userId: { organizationId: orgId, userId } },
    include: {
      user: { select: { id: true, email: true, name: true, isActive: true } },
    },
  });
};

/**
 * Whether the user is an `owner` or `admin` member of any organization,
 * inactive or archived ones included: they can be brought back.
 */
export const hasManagingMembership = async (
  userId: string,
  tx?: Prisma.TransactionClient
): Promise<boolean> => {
  const row = await (tx ?? prisma).organizationMember.findFirst({
    where: { userId, memberRole: { in: ["owner", "admin"] } },
    select: { id: true },
  });
  return row !== null;
};

export const getUserOrganizations = async (userId: string) => {
  // Archived ⇒ inactive, so excluding archived orgs changes nothing for
  // current callers (they all filter isActive) — it just guarantees a future
  // caller can never surface an archived org as a live membership.
  const memberships = await prisma.organizationMember.findMany({
    where: { userId, organization: { archivedAt: null } },
    include: {
      organization: {
        select: {
          id: true,
          name: true,
          slug: true,
          code: true,
          isActive: true,
          isDefault: true,
          createdAt: true,
          updatedAt: true,
        },
      },
    },
    orderBy: { organization: { name: "asc" } },
  });

  return memberships.map((m) => ({
    ...m.organization,
    memberRole: m.memberRole,
  }));
};

/**
 * Active, unarchived organizations, a page at a time: those `userId` belongs
 * to when `membersOnly`, otherwise all of them; with `search`, only those
 * whose name or slug contains it (case-insensitive). Each row carries the
 * user's member role there, or null.
 */
export const searchActive = async (options: {
  userId: string;
  membersOnly: boolean;
  search?: string;
  take: number;
  orderBy: Record<string, "asc" | "desc">[];
  /** The page's cursor clause. */
  where?: Record<string, unknown>;
}) => {
  const { userId, membersOnly, search, take, orderBy, where } = options;
  const rows = await prisma.organization.findMany({
    take: take + 1,
    orderBy,
    where: {
      AND: [
        (where ?? {}) as Prisma.OrganizationWhereInput,
        { isActive: true, archivedAt: null },
        membersOnly ? { members: { some: { userId } } } : {},
        search
          ? {
              OR: [
                { name: { contains: search, mode: "insensitive" } },
                { slug: { contains: search, mode: "insensitive" } },
              ],
            }
          : {},
      ],
    },
    select: {
      id: true,
      name: true,
      slug: true,
      members: { where: { userId }, select: { memberRole: true } },
    },
  });

  const hasMore = rows.length > take;
  const data = (hasMore ? rows.slice(0, take) : rows).map(
    ({ members, ...org }) => ({
      ...org,
      memberRole: members[0]?.memberRole ?? null,
    })
  );
  return { data, hasMore };
};

export const addMember = async (
  orgId: string,
  userId: string,
  role: OrgMemberRole = OrgMemberRole.member,
  tx?: Prisma.TransactionClient
) => {
  const existing = await getMembership(orgId, userId, tx);
  if (existing) {
    throw new ConflictError("User is already a member of this organization");
  }

  return await (tx ?? prisma).organizationMember.create({
    data: { organizationId: orgId, userId, memberRole: role },
    include: {
      user: { select: { id: true, email: true, name: true, isActive: true } },
    },
  });
};

export const removeMember = async (
  orgId: string,
  userId: string,
  tx?: Prisma.TransactionClient
) => {
  const existing = await getMembership(orgId, userId, tx);
  if (!existing) {
    throw new NotFoundError("User is not a member of this organization");
  }

  await (tx ?? prisma).organizationMember.delete({
    where: { organizationId_userId: { organizationId: orgId, userId } },
  });
  return existing;
};

export const updateMemberRole = async (
  orgId: string,
  userId: string,
  role: OrgMemberRole,
  tx?: Prisma.TransactionClient
) => {
  const existing = await getMembership(orgId, userId, tx);
  if (!existing) {
    throw new NotFoundError("User is not a member of this organization");
  }

  const updated = await (tx ?? prisma).organizationMember.update({
    where: { organizationId_userId: { organizationId: orgId, userId } },
    data: { memberRole: role },
    include: {
      user: { select: { id: true, email: true, name: true, isActive: true } },
    },
  });
  return { previousRole: existing.memberRole, member: updated };
};

export const getMemberRoles = async (
  orgId: string,
  userId: string,
  tx?: Prisma.TransactionClient
) => {
  return await (tx ?? prisma).userRole.findMany({
    where: { userId, organizationId: orgId },
    include: {
      role: { include: { rolePermissions: { include: { permission: true } } } },
    },
  });
};

export const setMemberRoles = async (
  orgId: string,
  userId: string,
  roleIds: string[],
  tx?: Prisma.TransactionClient,
  creatable?: ReadonlySet<string>
) => {
  // Roles that stay keep their rows, and so their expiry.
  await replaceAssignments(tx ?? prisma, userId, orgId, roleIds, creatable);
  return await getMemberRoles(orgId, userId, tx);
};
