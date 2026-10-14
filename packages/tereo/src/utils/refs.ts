/**
 * Compact objects embedded next to the foreign ids a response returns, so a
 * client can show who or what an id names without a second call. Each has a
 * Prisma `select` for relations and a `to…Ref` for the row it loads.
 */

export interface UserRef {
  id: string;
  email: string;
  name: string | null;
}

export interface OrgRef {
  id: string;
  name: string;
  slug: string;
}

export interface ServiceRef {
  id: string;
  slug: string;
  name: string;
}

export const userRefSelect = {
  select: { id: true, email: true, name: true },
} as const;

export const orgRefSelect = {
  select: { id: true, name: true, slug: true },
} as const;

export const serviceRefSelect = {
  select: { id: true, slug: true, name: true },
} as const;

export const toUserRef = (user: UserRef | null | undefined): UserRef | null =>
  user ? { id: user.id, email: user.email, name: user.name } : null;

export const toOrgRef = (org: OrgRef | null | undefined): OrgRef | null =>
  org ? { id: org.id, name: org.name, slug: org.slug } : null;

export const toServiceRef = (
  service: ServiceRef | null | undefined
): ServiceRef | null =>
  service ? { id: service.id, slug: service.slug, name: service.name } : null;
