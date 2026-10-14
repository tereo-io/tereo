import type { UserRef } from "@/lib/refs";

export interface BucketPermission {
  id: number;
  userId: string;
  userEmail: string | null;
  userName: string | null;
  user: UserRef | null;
  canRead: boolean;
  canWrite: boolean;
  canDelete: boolean;
  grantedAt: string;
  grantedBy: string;
  grantedByEmail: string | null;
  grantedByName: string | null;
  granter: UserRef | null;
}

export interface GrantPermissionInput {
  userId: string;
  canRead: boolean;
  canWrite: boolean;
  canDelete: boolean;
}
