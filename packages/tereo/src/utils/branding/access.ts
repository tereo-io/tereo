import { LOGIN_CLIENT } from "../../definitions/loginClient.js";
import { PERMISSIONS } from "../../definitions/permissions.js";
import { hasPermission } from "../permissions.js";
import { ForbiddenError } from "../errors.js";
import db from "../db/index.js";

export const CONSOLE_CLIENT_ID = LOGIN_CLIENT.clientId;

export type BrandingUser = { userId: string; permissions: string[] };
export type BrandingClient = { id: string; clientId: string; ownerId: string };
export type BrandingRole = "admin" | "owner" | "grantee";

export const isBrandingAdmin = (user: BrandingUser) =>
  hasPermission(user.permissions, PERMISSIONS.BRANDING.ADMIN);

/**
 * The caller's standing on a client's branding, before the read/write
 * permission check. The console client's profile is branding.admin's alone.
 */
export const brandingRole = async (
  user: BrandingUser,
  client: BrandingClient
): Promise<BrandingRole | null> => {
  if (isBrandingAdmin(user)) return "admin";
  if (client.clientId === CONSOLE_CLIENT_ID) return null;
  if (client.ownerId === user.userId) return "owner";
  const grant = await db.brandingGrants.getActive(client.id, user.userId);
  return grant ? "grantee" : null;
};

const refuse = (action: string) =>
  new ForbiddenError(
    `Only the client's owner, a user it granted branding to, or a branding.admin can ${action} its branding`
  );

const assertMay = async (
  user: BrandingUser,
  client: BrandingClient,
  permission: string,
  action: string
): Promise<BrandingRole> => {
  const role = await brandingRole(user, client);
  if (!role) throw refuse(action);
  if (!hasPermission(user.permissions, permission)) {
    throw new ForbiddenError(
      `The following permission is required: ${permission}`
    );
  }
  return role;
};

export const assertMayReadClientBranding = (
  user: BrandingUser,
  client: BrandingClient
) => assertMay(user, client, PERMISSIONS.BRANDING.READ, "view");

export const assertMayEditClientBranding = (
  user: BrandingUser,
  client: BrandingClient
) => assertMay(user, client, PERMISSIONS.BRANDING.WRITE, "edit");

/**
 * Whether the caller may list, add and revoke the client's grants. Nobody
 * holds grants on the console client: its branding is branding.admin's alone.
 */
export const mayManageGrants = (user: BrandingUser, client: BrandingClient) =>
  client.clientId !== CONSOLE_CLIENT_ID &&
  (isBrandingAdmin(user) || client.ownerId === user.userId);

export const assertMayManageGrants = (
  user: BrandingUser,
  client: BrandingClient
) => {
  if (!mayManageGrants(user, client)) {
    throw new ForbiddenError(
      client.clientId === CONSOLE_CLIENT_ID
        ? "The console client's branding takes no grants"
        : "Only the client's owner or a branding.admin can manage its branding grants"
    );
  }
};

export const assertBrandingAdmin = (user: BrandingUser) => {
  if (!isBrandingAdmin(user)) {
    throw new ForbiddenError(
      `The following permission is required: ${PERMISSIONS.BRANDING.ADMIN}`
    );
  }
};
