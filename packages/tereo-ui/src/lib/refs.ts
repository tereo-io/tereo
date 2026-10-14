/**
 * The compact objects core embeds next to the foreign ids it returns, so a
 * page can name an id without fetching it.
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

/** A user as a page names them: by name, else email. */
export const userLabel = (user: UserRef): string => user.name || user.email;
