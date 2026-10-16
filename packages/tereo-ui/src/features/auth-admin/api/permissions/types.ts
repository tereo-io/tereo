/**
 * A permission as core returns it. Permissions are declared in code by the
 * service that owns them and applied from its provisioning document — admins only read them.
 */
export interface Permission {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  /** The declaring service. */
  serviceId: string;
  serviceName: string;
  /**
   * Declared by the service: a role assigned within an organization may carry
   * it. Only these count from an org-scoped assignment.
   */
  orgAssignable: boolean;
  /** Set when the last declaration stopped listing it; cleared on re-declare. */
  missingSince: string | null;
  /** Set once missing past the grace period; a retired permission grants nothing. */
  retiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}
