import type { ServiceAccess } from "../../prisma/generated/client/index.js";
import { CORE_SERVICE_ID } from "../definitions/index.js";
import { withUserRefs } from "./users.js";
import { prisma } from "./db/prisma.js";

const isServiceRole = (row: Pick<ServiceAccess, "kind" | "target">) =>
  row.kind === "role" && row.target.includes("/");

/**
 * For each request for another service's role, the permission names it was
 * approved for and those the role grants beyond them while it is pending;
 * both null for core's roles and audiences.
 */
const withPermissions = async <T extends ServiceAccess>(rows: T[]) => {
  const targets = new Set(rows.filter(isServiceRole).map((r) => r.target));
  const slugs = [...targets].map((t) => t.slice(0, t.indexOf("/")));
  const roles =
    targets.size === 0
      ? []
      : await prisma.role.findMany({
          where: {
            serviceId: { not: CORE_SERVICE_ID },
            service: { slug: { in: [...new Set(slugs)] } },
          },
          select: {
            name: true,
            service: { select: { slug: true } },
            rolePermissions: {
              where: { permission: { retiredAt: null } },
              select: { permissionId: true },
            },
          },
        });
  const current = new Map(
    roles.map((r) => [
      `${r.service!.slug}/${r.name}`,
      r.rolePermissions.map((rp) => rp.permissionId),
    ])
  );
  const ids = [
    ...new Set([
      ...rows.flatMap((r) => r.approvedPermissionIds),
      ...[...current.values()].flat(),
    ]),
  ];
  const names = new Map(
    ids.length === 0
      ? []
      : (
          await prisma.permission.findMany({
            where: { id: { in: ids } },
            select: { id: true, name: true },
          })
        ).map((p) => [p.id, p.name])
  );
  const named = (list: string[]) =>
    list.flatMap((id) => names.get(id) ?? []).sort();

  return rows.map(({ approvedPermissionIds, ...row }) => {
    if (!isServiceRole(row)) {
      return { ...row, approvedPermissions: null, pendingPermissions: null };
    }
    const approved = new Set(approvedPermissionIds);
    const grants = current.get(row.target) ?? [];
    return {
      ...row,
      approvedPermissions: named(approvedPermissionIds),
      pendingPermissions:
        row.status === "pending"
          ? named(grants.filter((id) => !approved.has(id)))
          : [],
    };
  });
};

/**
 * Add who decided each access row, from one lookup: `decider`, and its email
 * and name flat. The `decidedBy` id stays; all three are null until the row
 * is first decided, and name the last decision after. Requests for another
 * service's role also carry `approvedPermissions` and `pendingPermissions`.
 */
export const withDeciders = async <T extends ServiceAccess>(rows: T[]) =>
  (
    await withPermissions(await withUserRefs(rows, { decider: "decidedBy" }))
  ).map((row) => ({
    ...row,
    decidedByEmail: row.decider?.email ?? null,
    decidedByName: row.decider?.name ?? null,
  }));
