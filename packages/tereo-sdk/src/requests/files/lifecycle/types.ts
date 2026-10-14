export interface LifecyclePolicy {
  expireObjectsAfterDays: number | null;
  expireVersionsAfterDays: number | null;
  purgeSoftDeletedAfterDays: number | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * The whole policy, not a patch: core sets a rule left out to `null` and
 * `enabled` left out to `true`. Read the policy first to change one rule.
 */
export interface UpsertLifecyclePolicyInput {
  expireObjectsAfterDays?: number | null;
  expireVersionsAfterDays?: number | null;
  purgeSoftDeletedAfterDays?: number | null;
  enabled?: boolean;
}
