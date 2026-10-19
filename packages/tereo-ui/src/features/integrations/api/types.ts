import type { OrgRef, UserRef } from "@/lib/refs";

export interface IntegrationRole {
  id: string;
  name: string;
  displayName: string;
  /** A core or service system role. */
  system: boolean;
}

/** An integration as `GET /admin/integrations` returns it. */
export interface Integration {
  id: string;
  slug: string;
  name: string;
  /** Set for an org-bound integration; null for a platform one. */
  organizationId: string | null;
  organization: OrgRef | null;
  isActive: boolean;
  provisioned: boolean;
  /** When it went missing from the provisioning documents; null while they list it. */
  unprovisionedAt: string | null;
  clientId: string | null;
  serviceAccountUserId: string | null;
  serviceAccountUser: UserRef | null;
  /** Org roles in its organization when org-bound, global roles otherwise. */
  roles: IntegrationRole[];
  audience: string[];
  /** Set while a regenerated secret's predecessor still works. */
  previousSecretExpiresAt: string | null;
  createdBy: string;
  creator: UserRef | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateIntegrationInput {
  name: string;
  slug?: string;
  organizationId?: string;
}

export interface UpdateIntegrationInput {
  name?: string;
  isActive?: boolean;
}

export interface IntegrationCredentials {
  clientId: string;
  clientSecret: string;
}

/** `POST /admin/integrations`: the new integration and its secret, shown once. */
export interface CreatedIntegration extends Integration {
  credentials: IntegrationCredentials;
}

/** `POST /admin/integrations/:id/regenerate-secret`. */
export interface RegeneratedIntegrationSecret extends IntegrationCredentials {
  previousSecretExpiresAt: string | null;
}

export interface ApiErrorBody {
  error?: string;
  error_description?: string;
}
