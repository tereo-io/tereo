/** One access request of a service, as core decided it. */
export interface AuthServiceOwnServiceAccess {
  kind: "role" | "audience";
  /** A core role, `<slug>/<role>` of another service, or an audience's slug. */
  target: string;
  status: "approved" | "revoked";
  /** ISO-8601 timestamp; null until decided. */
  decidedAt: string | null;
}

/**
 * The calling service, as `GET /v1/account/service` returns it: what core
 * last applied from its provisioning document, and its access.
 */
export interface AuthServiceOwnService {
  id: string;
  /** Also the `source` of its audit entries. */
  slug: string;
  name: string;
  namespace: string;
  isActive: boolean;
  provisioned: boolean;
  /** The `version` of the declaration last applied; null until one is. */
  declarationVersion: string | null;
  /** SHA-256 of the declaration last applied; null until one is. */
  declarationHash: string | null;
  /** ISO-8601 timestamp of the last apply; null until one. */
  declaredAt: string | null;
  access: AuthServiceOwnServiceAccess[];
}
