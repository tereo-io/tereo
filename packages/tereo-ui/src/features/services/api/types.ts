import type { UserRef } from "@/lib/refs";

/** The fields of core's service record the auth admin screens use. */
export interface ServiceSummary {
  id: string;
  slug: string;
  name: string;
  namespace: string;
  isActive: boolean;
}

/** A service as `GET /admin/services` returns it. */
export interface Service extends ServiceSummary {
  provisioned: boolean;
  /** Null only for core's own row, which has no OAuth client. */
  clientId: string | null;
  serviceAccountUserId: string | null;
  serviceAccountUser: UserRef | null;
  audience: string[];
  /** Set while a regenerated secret's predecessor still works. */
  previousSecretExpiresAt: string | null;
  declarationHash: string | null;
  /** The version of the declaration last applied; null if it never registered. */
  declarationVersion: string | null;
  /** When the service last registered a declaration; null if it never has. */
  declaredAt: string | null;
  createdBy: string | null;
  creator: UserRef | null;
  createdAt: string;
  updatedAt: string;
}

/** A row of `GET /admin/services`. */
export interface ServiceListItem extends Service {
  /** How many of its access requests await a decision. */
  pendingAccessCount: number;
}

/** Set on an item its service's latest declaration no longer lists. */
export interface Retirable {
  missingSince: string | null;
  retiredAt: string | null;
}

export interface DeclaredPermission extends Retirable {
  id: string;
  name: string;
  displayName: string;
}

export interface DeclaredSystemRole extends Retirable {
  id: string;
  name: string;
  displayName: string;
  permissions: string[];
}

export interface DeclaredBucket extends Retirable {
  id: string;
  name: string;
  policy: string;
  deletedAt: string | null;
}

export interface DeclaredEventType extends Retirable {
  eventType: string;
  description: string | null;
}

export type ServiceAccessKind = "role" | "audience";
export type ServiceAccessStatus = "pending" | "approved" | "revoked";

export interface ServiceAccess {
  id: string;
  serviceId: string;
  kind: ServiceAccessKind;
  /** A role name (`<slug>/<name>` for another service's) or a service slug. */
  target: string;
  status: ServiceAccessStatus;
  requestedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decidedByEmail: string | null;
  decidedByName: string | null;
  /** Another service's role: the permissions its approval recorded; null otherwise. */
  approvedPermissions: string[] | null;
  /** Another service's role while pending: what approving would add; null otherwise. */
  pendingPermissions: string[] | null;
}

/** A row of `GET /admin/services/access`, the cross-service inbox. */
export interface ServiceAccessListItem extends ServiceAccess {
  service: { id: string; slug: string; name: string };
}

/** Core's configuration for services, as this deployment has it set. */
export interface ServiceSettings {
  /** How long a replaced secret keeps working after a regeneration. */
  secretOverlapHours: number;
  /** How long a dropped declared item stays missing before it retires. */
  retirementGraceHours: number;
}

/** `GET /admin/services/:id`: the service, what it declared, its access. */
export interface ServiceDetail extends Service {
  declared: {
    permissions: DeclaredPermission[];
    systemRoles: DeclaredSystemRole[];
    buckets: DeclaredBucket[];
    eventTypes: DeclaredEventType[];
  };
  access: ServiceAccess[];
  settings: ServiceSettings;
}

export interface CreateServiceInput {
  name: string;
  slug?: string;
  namespace?: string;
}

export interface UpdateServiceInput {
  name?: string;
  isActive?: boolean;
}

export interface ServiceCredentials {
  clientId: string;
  clientSecret: string;
}

/** `POST /admin/services`: the new service and its credentials, shown once. */
export interface CreatedService extends Service {
  credentials: ServiceCredentials;
}

/** `POST /admin/services/:id/regenerate-secret`. */
export interface RegeneratedSecret extends ServiceCredentials {
  /** Until when the replaced secret still works; null if it stopped at once. */
  previousSecretExpiresAt: string | null;
}

export interface AccessDecisionInput {
  serviceId: string;
  ids: string[];
}

/** Core's error body. */
export interface ApiErrorBody {
  error?: string;
  error_description?: string;
}
