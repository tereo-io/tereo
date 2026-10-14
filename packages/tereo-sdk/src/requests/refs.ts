/**
 * Compact objects core embeds next to the foreign ids a response returns
 * (`creator` beside `createdBy`, `organization` beside `organizationId`), so
 * the id can be shown without a second call.
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

export interface RoleRef {
  id: string;
  name: string;
  displayName: string;
}
