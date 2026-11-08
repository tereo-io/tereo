import { Prisma } from "../../../prisma/generated/client/index.js";
import { orgRefSelect, serviceRefSelect } from "../refs.js";
import { prisma } from "./prisma.js";
import {
  isCorePermission,
  isGuestAllowedCorePermission,
} from "../../definitions/guests.js";
import {
  AlreadyArchivedError,
  ArchivedError,
  ConflictError,
  ForbiddenError,
  NotArchivedError,
  NotFoundError,
} from "../errors.js";

const withPermissionsAndService = {
  rolePermissions: { include: { permission: true } },
  service: serviceRefSelect,
} satisfies Prisma.RoleInclude;

/** A custom role. System roles are written only by the registry. */
export interface CreateRoleInput {
  name: string;
  displayName: string;
  description?: string;
  requires2fa?: boolean;
  guestAssignable?: boolean;
  provisioned?: boolean;
}

export interface UpdateRoleInput {
  name?: string;
  displayName?: string;
  description?: string;
  isActive?: boolean;
  requires2fa?: boolean;
  guestAssignable?: boolean;
}

/**
 * Operational lookup — archived roles are invisible here, exactly as
 * soft-deleted ones were before the rename. Admin/restore paths that must
 * see archived rows use `getAny`.
 */
export const get = async (id: string, tx?: Prisma.TransactionClient) => {
  const db = tx ?? prisma;
  const res = await db.role.findUnique({
    where: { id, archivedAt: null },
    include: withPermissionsAndService,
  });
  if (!res) throw new NotFoundError("Role not found");
  return res;
};

/** Admin lookup that also returns archived roles. */
export const getAny = async (id: string, tx?: Prisma.TransactionClient) => {
  const db = tx ?? prisma;
  const res = await db.role.findUnique({
    where: { id },
    include: withPermissionsAndService,
  });
  if (!res) throw new NotFoundError("Role not found");
  return res;
};

/**
 * Any-state custom-role lookup for duplicate checks — the unique index spans
 * archived rows, so creates/renames must see them or they 500 on P2002.
 * System roles live in their own keyspace and never collide.
 */
export const getCustomByNameAny = async (name: string) => {
  return await prisma.role.findFirst({ where: { name, serviceId: null } });
};

export const getAll = async () => {
  return await prisma.role.findMany({
    where: { archivedAt: null },
    orderBy: { name: "asc" },
    include: withPermissionsAndService,
  });
};

interface GetPaginatedOptions {
  /** Over-fetch happens inside the helper — pass the user's requested page size. */
  take: number;
  orderBy?: Record<string, "asc" | "desc">[];
  where?: Record<string, unknown>;
  /** Include archived rows (default false). Admin listing only. */
  includeArchived?: boolean;
}

export const getPaginated = async (options: GetPaginatedOptions) => {
  const { take, orderBy, where, includeArchived } = options;

  // The archive guard spreads LAST so no caller-supplied filter can
  // override it.
  const whereClause = {
    ...where,
    ...(includeArchived ? {} : { archivedAt: null }),
  };

  const rows = await prisma.role.findMany({
    take: take + 1,
    orderBy: orderBy as Record<string, "asc" | "desc">[],
    where: whereClause,
    include: withPermissionsAndService,
  });

  const hasMore = rows.length > take;
  const data = hasMore ? rows.slice(0, take) : rows;

  return { data, hasMore };
};

const grantedPermission = {
  select: { name: true, retiredAt: true, orgAssignable: true },
} as const;

/** Assignable roles among `ids`: not archived, not retired. */
export const getByIds = async (
  ids: string[],
  tx: Prisma.TransactionClient = prisma
) => {
  return await tx.role.findMany({
    where: { id: { in: ids }, archivedAt: null, retiredAt: null },
    include: {
      rolePermissions: { include: { permission: grantedPermission } },
    },
  });
};

/** The names of the permissions these roles grant: retired ones grant nothing. */
export const grantedPermissionNames = (
  roles: {
    rolePermissions: { permission: { name: string; retiredAt: Date | null } }[];
  }[]
): string[] => [
  ...new Set(
    roles.flatMap((role) =>
      role.rolePermissions
        .filter((rp) => !rp.permission.retiredAt)
        .map((rp) => rp.permission.name)
    )
  ),
];

/**
 * The permissions these roles grant that a role assigned within an
 * organization may not carry.
 */
export const notOrgAssignablePermissionNames = (
  roles: {
    rolePermissions: {
      permission: {
        name: string;
        retiredAt: Date | null;
        orgAssignable: boolean;
      };
    }[];
  }[]
): string[] =>
  [
    ...new Set(
      roles.flatMap((role) =>
        role.rolePermissions
          .filter(
            (rp) => !rp.permission.retiredAt && !rp.permission.orgAssignable
          )
          .map((rp) => rp.permission.name)
      )
    ),
  ].sort();

export const create = async (
  data: CreateRoleInput,
  tx?: Prisma.TransactionClient
) => {
  const db = tx ?? prisma;
  return await db.role.create({
    data: {
      name: data.name,
      displayName: data.displayName,
      description: data.description,
      requires2fa: data.requires2fa ?? false,
      guestAssignable: data.guestAssignable ?? false,
      provisioned: data.provisioned ?? false,
    },
  });
};

export const update = async (
  id: string,
  data: UpdateRoleInput,
  tx?: Prisma.TransactionClient
) => {
  const db = tx ?? prisma;
  // Callers check the role is not archived before this; the WHERE repeats
  // it so an archive committing in between leaves no archived role
  // reactivated. Losing that race answers as guardArchived would have.
  const result = await db.role.updateMany({
    where: { id, archivedAt: null },
    data,
  });
  if (result.count === 0) {
    if (await db.role.findUnique({ where: { id } })) {
      throw new ArchivedError();
    }
    throw new NotFoundError("Role not found");
  }
  return await db.role.findUniqueOrThrow({ where: { id } });
};

export const archive = async (id: string, tx?: Prisma.TransactionClient) => {
  const db = tx ?? prisma;
  const existing = await db.role.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Role not found");
  if (existing.archivedAt) {
    throw new AlreadyArchivedError("Role is already archived");
  }
  if (existing.serviceId) {
    throw new ForbiddenError("System roles cannot be archived");
  }
  if (existing.isActive) {
    throw new ConflictError(
      "Role must be deactivated before it can be archived"
    );
  }
  // Re-assert the gate in the WHERE so a concurrent reactivate/archive can't
  // slip through between the read above and this write; 0 rows means the race
  // was lost.
  const result = await db.role.updateMany({
    where: { id, archivedAt: null, isActive: false, serviceId: null },
    data: { archivedAt: new Date() },
  });
  if (result.count === 0) {
    throw new ConflictError(
      "Role must be deactivated before it can be archived"
    );
  }
  return await db.role.findUniqueOrThrow({ where: { id } });
};

export const restore = async (id: string, tx?: Prisma.TransactionClient) => {
  const db = tx ?? prisma;
  const existing = await db.role.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Role not found");
  if (!existing.archivedAt) {
    throw new NotArchivedError("Role is not archived");
  }
  // Restored roles come back deactivated — they grant nothing until an
  // admin explicitly reactivates them (PATCH isActive).
  return await db.role.update({
    where: { id },
    data: { archivedAt: null },
  });
};

/**
 * Hard delete — role-permission and user-role assignment rows Cascade
 * (join rows go with the role). Returns the pre-delete row for
 * audit/webhook payloads.
 */
export const remove = async (id: string, tx?: Prisma.TransactionClient) => {
  const db = tx ?? prisma;
  const existing = await db.role.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Role not found");
  if (existing.serviceId) {
    throw new ForbiddenError("System roles cannot be deleted");
  }
  await db.role.delete({ where: { id } });
  return existing;
};

export const setPermissions = async (
  roleId: string,
  permissionIds: string[],
  tx?: Prisma.TransactionClient
) => {
  const db = tx ?? prisma;
  await db.rolePermission.deleteMany({ where: { roleId } });

  if (permissionIds.length > 0) {
    await db.rolePermission.createMany({
      data: permissionIds.map((permissionId) => ({ roleId, permissionId })),
    });
  }

  return await get(roleId, tx);
};

export const getGlobalUserRoles = async (
  userId: string,
  tx?: Prisma.TransactionClient
) => {
  const db = tx ?? prisma;
  return await db.userRole.findMany({
    where: { userId, organizationId: null },
    include: { role: true },
  });
};

/**
 * Replaces only the global assignments; org-scoped ones are managed per
 * organization and must survive. A role kept in the set keeps its row, and
 * with it its `expiresAt`: only removed roles are deleted, only new ones
 * created.
 */
export const setUserRoles = async (
  userId: string,
  roleIds: string[],
  tx?: Prisma.TransactionClient,
  creatable?: ReadonlySet<string>
) => {
  const db = tx ?? prisma;
  await replaceAssignments(db, userId, null, roleIds, creatable);
  return await getGlobalUserRoles(userId, tx);
};

/**
 * Make `roleIds` the user's assignments in one scope (an organization, or
 * global for null), leaving the rows of roles that stay untouched. With
 * `creatable`, only those roles are created: a role the caller was let keep
 * unchecked, because the user held it, is not recreated if it went away since.
 */
export const replaceAssignments = async (
  db: Prisma.TransactionClient,
  userId: string,
  organizationId: string | null,
  roleIds: string[],
  creatable?: ReadonlySet<string>
) => {
  await db.userRole.deleteMany({
    where: { userId, organizationId, roleId: { notIn: roleIds } },
  });
  const kept = await db.userRole.findMany({
    where: { userId, organizationId },
    select: { roleId: true },
  });
  const held = new Set(kept.map((ur) => ur.roleId));
  const added = roleIds.filter(
    (roleId) => !held.has(roleId) && (!creatable || creatable.has(roleId))
  );
  if (added.length > 0) {
    await db.userRole.createMany({
      data: added.map((roleId) => ({ userId, roleId, organizationId })),
    });
  }
};

export const removeUserRole = async (
  userId: string,
  roleId: string,
  organizationId?: string,
  tx?: Prisma.TransactionClient
) => {
  const db = tx ?? prisma;
  // Use findFirst since partial unique indexes aren't modeled in Prisma
  const userRole = await db.userRole.findFirst({
    where: {
      userId,
      roleId,
      organizationId: organizationId ?? null,
    },
  });
  if (!userRole) throw new NotFoundError("User role assignment not found");
  return await db.userRole.delete({ where: { id: userRole.id } });
};

const unexpired = (): Prisma.UserRoleWhereInput => ({
  OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
});

/**
 * Where an assignment counts. A role granted in one organization must not
 * reach a token or check that names another, or none.
 *
 * - an organization id: global assignments and that organization's;
 * - `null`/`undefined`: global assignments only;
 * - `"memberships"`: global assignments and those of every active
 *   organization the user is a member of. For a decision taken before an
 *   organization is chosen (2FA at sign-in), which must hold for whichever
 *   one is chosen next;
 * - `"anywhere"`: global assignments and those of every organization, active
 *   or not. For a question about everything the user could act with, in any
 *   organization (who may reset their credentials).
 */
export type AssignmentScope =
  string | null | undefined | "memberships" | "anywhere";

export interface AssignmentOptions {
  /**
   * Count deactivated roles too (still not archived or retired ones): for a
   * question about what the user could hold again once an admin reactivates
   * a role, such as who may act on their account.
   */
  includeInactiveRoles?: boolean;
  /**
   * For a guest, count every assignment and permission as for a human: what
   * they would hold once promoted, such as who may act on their account.
   */
  ignoreGuestFloor?: boolean;
}

/**
 * The assignments that count in `scope`: unexpired, of an active role that is
 * neither archived nor retired (or, with `includeInactiveRoles`, of any role
 * that is neither).
 */
export const liveAssignmentsWhere = (
  userId: string,
  scope: AssignmentScope,
  { includeInactiveRoles = false }: AssignmentOptions = {}
): Prisma.UserRoleWhereInput => {
  const inScope: Prisma.UserRoleWhereInput =
    scope === "memberships"
      ? {
          OR: [
            { organizationId: null },
            {
              organization: {
                isActive: true,
                archivedAt: null,
                members: { some: { userId } },
              },
            },
          ],
        }
      : scope === "anywhere"
        ? {}
        : scope
          ? { OR: [{ organizationId: scope }, { organizationId: null }] }
          : { organizationId: null };

  return {
    userId,
    role: {
      ...(includeInactiveRoles ? {} : { isActive: true }),
      archivedAt: null,
      retiredAt: null,
    },
    AND: [unexpired(), inScope],
  };
};

/**
 * The only assignments that count for a guest: org-scoped, of a role still
 * flagged guest-assignable. Combine with `liveAssignmentsWhere` under `AND`.
 */
export const guestAssignmentsWhere: Prisma.UserRoleWhereInput = {
  organizationId: { not: null },
  role: { guestAssignable: true },
};

export const isGuest = async (
  userId: string,
  tx?: Prisma.TransactionClient
): Promise<boolean> => {
  const user = await (tx ?? prisma).user.findUnique({
    where: { id: userId },
    select: { userType: true },
  });
  return user?.userType === "guest";
};

/** How a user holds a role: assigned to them, or through a group. */
export type AssignmentVia =
  { kind: "direct" } | { kind: "group"; groupId: string };

const assignmentRoleInclude = {
  rolePermissions: { include: { permission: grantedPermission } },
} satisfies Prisma.RoleInclude;

/** A role a user holds in one scope, directly or through a group. */
export interface EffectiveAssignment {
  roleId: string;
  organizationId: string | null;
  role: Prisma.RoleGetPayload<{ include: typeof assignmentRoleInclude }>;
  via: AssignmentVia;
  /** Direct rows only: a service's approved access to another's role. */
  serviceAccess: { approvedPermissionIds: string[] } | null;
  /** Direct rows only; a group membership does not expire. */
  expiresAt: Date | null;
}

/**
 * Where a group's roles count, as `liveAssignmentsWhere` scopes a direct
 * assignment. An org group counts only while the user is still a member of
 * its organization, and, wherever the scope asks for one usable now, while
 * that organization is active.
 */
const groupInScope = (
  userId: string,
  scope: AssignmentScope
): Prisma.GroupWhereInput => {
  const member: Prisma.OrganizationWhereInput = {
    members: { some: { userId } },
  };
  const usable: Prisma.OrganizationWhereInput = {
    ...member,
    isActive: true,
    archivedAt: null,
  };
  if (scope === "memberships") {
    return { OR: [{ organizationId: null }, { organization: usable }] };
  }
  if (scope === "anywhere") {
    return { OR: [{ organizationId: null }, { organization: member }] };
  }
  if (scope) {
    return {
      OR: [
        { organizationId: null },
        { organizationId: scope, organization: usable },
      ],
    };
  }
  return { organizationId: null };
};

const assignmentsFor = async (
  userId: string,
  scope: AssignmentScope,
  guest: boolean,
  db: Prisma.TransactionClient,
  options: AssignmentOptions = {}
): Promise<EffectiveAssignment[]> => {
  const live = liveAssignmentsWhere(userId, scope, options);
  // One after the other: `db` may be an interactive transaction.
  const direct = await db.userRole.findMany({
    where: guest ? { AND: [live, guestAssignmentsWhere] } : live,
    include: {
      role: { include: assignmentRoleInclude },
      serviceAccess: { select: { approvedPermissionIds: true } },
    },
  });
  const viaGroups = await db.groupRole.findMany({
    where: {
      role: {
        ...(options.includeInactiveRoles ? {} : { isActive: true }),
        archivedAt: null,
        retiredAt: null,
        // The guest floor, as `guestAssignmentsWhere` sets it for direct
        // rows. Guests are never members; this is a backstop.
        ...(guest ? { guestAssignable: true } : {}),
      },
      group: {
        archivedAt: null,
        members: { some: { userId } },
        ...(guest ? { organizationId: { not: null } } : {}),
        AND: [groupInScope(userId, scope)],
      },
    },
    include: {
      role: { include: assignmentRoleInclude },
      group: { select: { organizationId: true } },
    },
  });
  return [
    ...direct.map((ur): EffectiveAssignment => ({
      roleId: ur.roleId,
      organizationId: ur.organizationId,
      role: ur.role,
      via: { kind: "direct" },
      serviceAccess: ur.serviceAccess,
      expiresAt: ur.expiresAt,
    })),
    ...viaGroups.map((gr): EffectiveAssignment => ({
      roleId: gr.roleId,
      organizationId: gr.group.organizationId,
      role: gr.role,
      via: { kind: "group", groupId: gr.groupId },
      serviceAccess: null,
      expiresAt: null,
    })),
  ];
};

/**
 * Every role the user holds that counts in `scope` (see
 * `liveAssignmentsWhere`), directly or through a live group, one entry per
 * way it is held. For a guest, only those that grant them anything, unless
 * `ignoreGuestFloor`.
 */
export const effectiveAssignments = async (
  userId: string,
  scope: AssignmentScope,
  tx?: Prisma.TransactionClient,
  options?: AssignmentOptions
): Promise<EffectiveAssignment[]> => {
  const guest = !options?.ignoreGuestFloor && (await isGuest(userId, tx));
  return await assignmentsFor(userId, scope, guest, tx ?? prisma, options);
};

/** One entry per role and scope; a direct assignment wins over a group's. */
export const dedupeAssignments = (
  assignments: EffectiveAssignment[]
): EffectiveAssignment[] => {
  const byKey = new Map<string, EffectiveAssignment>();
  for (const a of assignments) {
    const key = `${a.roleId}:${a.organizationId ?? ""}`;
    const seen = byKey.get(key);
    if (!seen || (seen.via.kind === "group" && a.via.kind === "direct")) {
      byKey.set(key, a);
    }
  }
  return [...byKey.values()];
};

/**
 * Users holding a role matching `role`, directly or through an unarchived
 * group. Broader than `effectiveAssignments` (no expiry, scope or membership
 * check), so it suits a filter that may take in more users than it must,
 * such as token revocation.
 */
export const holdsRoleWhere = (
  role: Prisma.RoleWhereInput
): Prisma.UserWhereInput => ({
  OR: [
    { userRoles: { some: { role } } },
    {
      groupMemberships: {
        some: { group: { archivedAt: null, roles: { some: { role } } } },
      },
    },
  ],
});

/**
 * Whether a role the user holds requires 2FA. The assignments counted are the
 * ones that grant permissions, in the scope of every active organization the
 * user belongs to: 2FA is decided at sign-in, before an organization is
 * chosen, so it must hold for whichever one is chosen. A guest's assignments
 * outside the guest floor grant nothing, so they demand nothing, unless
 * `ignoreGuestFloor` (the guest about to become a regular user).
 */
export const holdsRequires2faRole = async (
  userId: string,
  tx?: Prisma.TransactionClient,
  options?: Pick<AssignmentOptions, "ignoreGuestFloor">
): Promise<boolean> =>
  (await effectiveAssignments(userId, "memberships", tx, options)).some(
    (a) => a.role.requires2fa
  );

/**
 * A user's roles that count in `scope` (see `liveAssignmentsWhere`), direct
 * or through a group, once per role and scope; for a guest, only those that
 * grant them anything (`guestAssignmentsWhere`).
 */
export const getLiveUserRoles = async (
  userId: string,
  scope: AssignmentScope
): Promise<EffectiveAssignment[]> =>
  dedupeAssignments(await effectiveAssignments(userId, scope)).sort((a, b) =>
    a.role.name < b.role.name ? -1 : a.role.name > b.role.name ? 1 : 0
  );

/**
 * The permissions a user holds through their global roles (no organization)
 * and, given an organization, that organization's roles too. Without one,
 * no org-scoped role counts: a role granted in one organization must not
 * reach a token or check that names none. An org-scoped role grants only its
 * org-assignable permissions, whatever else it carries.
 */
export const getUserPermissions = async (
  userId: string,
  organizationId?: string | null,
  tx?: Prisma.TransactionClient
): Promise<string[]> =>
  await permissionsInScope(userId, organizationId ?? null, tx);

/**
 * The permissions a user holds through their global roles and their roles in
 * every organization, active or not: what they could act with somewhere. An
 * org-scoped role still grants only its org-assignable permissions.
 */
export const getUserPermissionsAnywhere = async (
  userId: string,
  tx?: Prisma.TransactionClient,
  options?: AssignmentOptions
): Promise<string[]> =>
  await permissionsInScope(userId, "anywhere", tx, options);

const permissionsInScope = async (
  userId: string,
  scope: AssignmentScope,
  tx?: Prisma.TransactionClient,
  options?: AssignmentOptions
): Promise<string[]> => {
  const guest = !options?.ignoreGuestFloor && (await isGuest(userId, tx));
  const assignments = await assignmentsFor(
    userId,
    scope,
    guest,
    tx ?? prisma,
    options
  );

  const permissionSet = new Set<string>();

  for (const assignment of assignments) {
    const orgScoped = assignment.organizationId !== null;
    // A service's access to another service's role grants only what an admin
    // approved; what the role gained since waits for approval.
    const approved = assignment.serviceAccess
      ? new Set(assignment.serviceAccess.approvedPermissionIds)
      : null;
    for (const rp of assignment.role.rolePermissions) {
      // A retired permission stays on custom roles but grants nothing.
      if (rp.permission.retiredAt) continue;
      if (orgScoped && !rp.permission.orgAssignable) continue;
      if (approved && !approved.has(rp.permissionId)) continue;
      // Backstop for a flagged role that gained a core permission outside
      // the guest floor some other way than the admin API.
      if (
        guest &&
        isCorePermission(rp.permission.name) &&
        !isGuestAllowedCorePermission(rp.permission.name)
      ) {
        continue;
      }
      permissionSet.add(rp.permission.name);
    }
  }

  return Array.from(permissionSet).sort();
};

const carriesNotOrgAssignable = {
  rolePermissions: {
    some: { permission: { orgAssignable: false, retiredAt: null } },
  },
} satisfies Prisma.RoleWhereInput;

/**
 * Org-scoped assignments, and unarchived org groups' roles, whose role carries
 * a permission that is not org-assignable. They stay, and grant only their
 * org-assignable permissions.
 */
export const countInertOrgAssignments = async (): Promise<number> => {
  const [direct, viaGroups] = await Promise.all([
    prisma.userRole.count({
      where: { organizationId: { not: null }, role: carriesNotOrgAssignable },
    }),
    prisma.groupRole.count({
      where: {
        group: { organizationId: { not: null }, archivedAt: null },
        role: carriesNotOrgAssignable,
      },
    }),
  ]);
  return direct + viaGroups;
};

/**
 * Up to `take` ids, sorted, of the organizations the role is held within:
 * by an org-scoped assignment or by one of the organization's unarchived
 * groups.
 */
export const getOrgIdsHoldingRole = async (
  roleId: string,
  take: number,
  tx: Prisma.TransactionClient
): Promise<string[]> => {
  const direct = await tx.userRole.findMany({
    where: { roleId, organizationId: { not: null } },
    distinct: ["organizationId"],
    select: { organizationId: true },
    orderBy: { organizationId: "asc" },
    take,
  });
  const viaGroups = await tx.group.findMany({
    where: {
      organizationId: { not: null },
      archivedAt: null,
      roles: { some: { roleId } },
    },
    distinct: ["organizationId"],
    select: { organizationId: true },
    orderBy: { organizationId: "asc" },
    take,
  });
  const ids = new Set(
    [...direct, ...viaGroups].flatMap((r) =>
      r.organizationId ? [r.organizationId] : []
    )
  );
  return [...ids].sort().slice(0, take);
};

/**
 * One row per way a user holds the role: each assignment, and each
 * unarchived group holding it that they belong to.
 */
export const getUsersByRoleId = async (roleId: string) => {
  const userRoles = await prisma.userRole.findMany({
    where: { roleId },
    include: { user: true, organization: orgRefSelect },
  });
  const members = await prisma.groupMember.findMany({
    where: { group: { archivedAt: null, roles: { some: { roleId } } } },
    include: {
      user: true,
      group: { select: { organizationId: true, organization: orgRefSelect } },
    },
  });

  const rows = [
    ...userRoles.map((ur) => ({
      id: ur.user.id,
      email: ur.user.email,
      name: ur.user.name,
      isActive: ur.user.isActive,
      organizationId: ur.organizationId,
      organization: ur.organization,
      expiresAt: ur.expiresAt,
      via: { kind: "direct" } as AssignmentVia,
    })),
    ...members.map((m) => ({
      id: m.user.id,
      email: m.user.email,
      name: m.user.name,
      isActive: m.user.isActive,
      organizationId: m.group.organizationId,
      organization: m.group.organization,
      expiresAt: null,
      via: { kind: "group", groupId: m.groupId } as AssignmentVia,
    })),
  ];
  return rows.sort((a, b) =>
    a.email < b.email ? -1 : a.email > b.email ? 1 : 0
  );
};

/** Users holding the role directly or through an unarchived group, once each. */
export const getUserIdsByRoleId = async (
  roleId: string,
  tx?: Prisma.TransactionClient
): Promise<{ userId: string; user: { oauthClientId: string | null } }[]> => {
  const users = await (tx ?? prisma).user.findMany({
    where: holdsRoleWhere({ id: roleId }),
    select: { id: true, oauthClientId: true },
  });
  return users.map((u) => ({
    userId: u.id,
    user: { oauthClientId: u.oauthClientId },
  }));
};

const grantsAdmin = {
  isActive: true,
  archivedAt: null,
  retiredAt: null,
  rolePermissions: {
    some: { permission: { name: "admin", retiredAt: null } },
  },
} satisfies Prisma.RoleWhereInput;

const activeHuman = {
  isActive: true,
  userType: "human",
} satisfies Prisma.UserWhereInput;

/**
 * Global, unexpired assignments of an active role granting the `admin`
 * permission to an active human — the accounts that can still administer
 * core — and the same role held by an active human through an unarchived
 * global group (`groupId` set). Org-scoped assignments and org groups grant
 * nothing outside their organization.
 */
export const getAdminAssignments = async (
  tx?: Prisma.TransactionClient
): Promise<{ userId: string; roleId: string; groupId: string | null }[]> => {
  const db = tx ?? prisma;
  const direct = await db.userRole.findMany({
    where: {
      organizationId: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      user: activeHuman,
      role: grantsAdmin,
    },
    select: { userId: true, roleId: true },
  });
  const viaGroups = await db.groupRole.findMany({
    where: {
      role: grantsAdmin,
      group: { organizationId: null, archivedAt: null },
    },
    select: {
      roleId: true,
      groupId: true,
      group: {
        select: {
          members: { where: { user: activeHuman }, select: { userId: true } },
        },
      },
    },
  });
  return [
    ...direct.map((a) => ({ ...a, groupId: null })),
    ...viaGroups.flatMap((gr) =>
      gr.group.members.map((m) => ({
        userId: m.userId,
        roleId: gr.roleId,
        groupId: gr.groupId,
      }))
    ),
  ];
};

/** Of these roles, the ids of the ones granting `admin`. */
export const getAdminRoleIds = async (
  roleIds: string[],
  tx?: Prisma.TransactionClient
): Promise<string[]> => {
  if (roleIds.length === 0) return [];
  const roles = await (tx ?? prisma).role.findMany({
    where: { id: { in: roleIds }, ...grantsAdmin },
    select: { id: true },
  });
  return roles.map((r) => r.id);
};

/**
 * Row-locks the roles for the rest of `tx`, shared or (`update`) exclusive:
 * a role gaining `admin` holds them exclusively while it checks who holds
 * it, and an integration taking roles holds them shared while it checks
 * they carry none.
 */
export const lockRoles = async (
  ids: string[],
  mode: "share" | "update",
  tx: Prisma.TransactionClient
): Promise<void> => {
  if (ids.length === 0) return;
  if (mode === "update") {
    await tx.$queryRaw`SELECT 1 FROM "auth"."roles" WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
  } else {
    await tx.$queryRaw`SELECT 1 FROM "auth"."roles" WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR SHARE`;
  }
};

/** The slugs of the integrations whose accounts hold the role, in any scope. */
export const integrationHolderSlugs = async (
  roleId: string,
  tx: Prisma.TransactionClient
): Promise<string[]> => {
  const services = await tx.service.findMany({
    where: {
      kind: "integration",
      client: { serviceAccountUser: { userRoles: { some: { roleId } } } },
    },
    select: { slug: true },
    orderBy: { slug: "asc" },
  });
  return services.map((s) => s.slug);
};
