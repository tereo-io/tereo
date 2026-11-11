import { SYSTEM_USER, SYSTEM_USER_ID } from "../../definitions/index.js";
import type { Prisma } from "../../../prisma/generated/client/index.js";
import { BadRequestError, ConflictError } from "../errors.js";
import { uniqueViolationFields } from "../prismaErrors.js";
import type { ScimUserInput } from "./mapping.js";
import type { ScimUserLink } from "../db/scim.js";
import type { ScimContext } from "./context.js";
import type { ScimFilter } from "./filter.js";
import { logAuditTx } from "../outbox.js";
import { emailDomain } from "../email.js";
import db from "../db/index.js";
import {
  domainPlacement,
  organizationClosed,
} from "../identityProviders/placement.js";
import {
  createUserInOrganizationTx,
  updateUserProfileTx,
  type Actor,
  type UserRow,
  type UserProfile,
} from "../userLifecycle.js";

type Tx = Prisma.TransactionClient;

export type Visible = { user: UserRow; link: ScimUserLink | null };

const toVisible = ({
  scimLink,
  ...user
}: UserRow & { scimLink: ScimUserLink | null }): Visible => ({
  user,
  link: scimLink,
});

const scope = (ctx: ScimContext) => ({
  connectionId: ctx.connection.id,
  providerId: ctx.provider.id,
});

export const providerDomains = async (
  ctx: ScimContext,
  tx?: Tx
): Promise<string[]> => await db.scim.listProviderDomains(ctx.provider.id, tx);

export const findVisible = async (
  ctx: ScimContext,
  userId: string,
  tx?: Tx
): Promise<Visible | null> => {
  const found = await db.scim.findVisibleUser(scope(ctx), userId, tx);
  return found ? toVisible(found) : null;
};

export const listVisible = async (
  ctx: ScimContext,
  filter: ScimFilter,
  page: { startIndex: number; count: number }
): Promise<{ items: Visible[]; total: number }> => {
  const { items, total } = await db.scim.listVisibleUsers(scope(ctx), filter, {
    skip: page.startIndex - 1,
    take: page.count,
  });
  return { items: items.map(toVisible), total };
};

export const SYSTEM_ACTOR: Actor = {
  userId: SYSTEM_USER_ID,
  email: SYSTEM_USER.email,
};

export type ActiveChange = "deactivate" | "reactivate" | null;

export type Applied = {
  user: UserRow;
  link: ScimUserLink;
  activeChange: ActiveChange;
};

// One answer for every account SCIM may not have, whichever the reason.
const uniqueness = () =>
  new ConflictError(
    "A user with this userName, externalId or email already exists",
    "uniqueness"
  );

const auditMetadata = (ctx: ScimContext) => ({
  scimConnectionId: ctx.connection.id,
  providerId: ctx.provider.id,
});

/** What the managed user's `is_active` should become: `idp_active AND NOT admin_hold`. */
const activeChangeOf = (user: UserRow, link: ScimUserLink): ActiveChange => {
  const active = link.idpActive && !link.adminHold;
  if (active === user.isActive) return null;
  return active ? "reactivate" : "deactivate";
};

/**
 * Links an unmanaged, visible user to the connection. The caller holds the
 * user's lock and has checked that no link exists.
 */
export const adoptTx = async (
  tx: Tx,
  ctx: ScimContext,
  user: UserRow,
  input: Pick<ScimUserInput, "userName" | "externalId">
): Promise<ScimUserLink> => {
  // An inactive user was deactivated by an admin: the IdP's first sync must
  // not bring them back.
  const link = await db.scim.createLink(
    {
      connectionId: ctx.connection.id,
      userId: user.id,
      externalId: input.externalId ?? null,
      userName: input.userName ?? user.email,
      idpActive: user.isActive,
      adminHold: !user.isActive,
    },
    tx
  );
  await logAuditTx(tx, {
    auth: SYSTEM_ACTOR,
    action: "UPDATE",
    entityType: "User",
    entityId: user.id,
    entityName: user.email,
    metadata: { action: "scim_adopted", ...auditMetadata(ctx) },
  });
  return link;
};

const profileChanges = (user: UserRow, input: ScimUserInput): UserProfile => {
  const profile: UserProfile = {};
  for (const key of ["name", "firstName", "lastName"] as const) {
    const value = input[key];
    if (value !== undefined && value !== user[key]) profile[key] = value;
  }
  return profile;
};

/** Applies what `input` names; `activeChange` is left for the caller to act on. */
export const applyUserInputTx = async (
  tx: Tx,
  ctx: ScimContext,
  target: { user: UserRow; link: ScimUserLink },
  input: ScimUserInput
): Promise<Applied> => {
  let { user, link } = target;
  const linkData: Parameters<typeof db.scim.updateLink>[1] = {};
  if (input.userName !== undefined && input.userName !== link.userName) {
    linkData.userName = input.userName;
  }
  if (input.externalId !== undefined && input.externalId !== link.externalId) {
    linkData.externalId = input.externalId;
  }
  if (input.active !== undefined && input.active !== link.idpActive) {
    linkData.idpActive = input.active;
  }
  if (Object.keys(linkData).length > 0) {
    link = await db.scim.updateLink(link.id, linkData, tx);
  }
  const profile = profileChanges(user, input);
  if (Object.keys(profile).length > 0) {
    user = await updateUserProfileTx(tx, SYSTEM_ACTOR, user, profile, {
      auditMetadata: auditMetadata(ctx),
    });
  }
  return { user, link, activeChange: activeChangeOf(user, link) };
};

// The same whether or not an account has the address.
const outsideDomains = () =>
  new BadRequestError(
    "invalidValue",
    "The email address is not in one of the provider's domains"
  );

const createTx = async (
  tx: Tx,
  ctx: ScimContext,
  input: ScimUserInput & { email: string; userName: string }
): Promise<Applied> => {
  const domain = await db.identityProviders.findDomain(
    emailDomain(input.email),
    tx
  );
  if (!domain || domain.providerId !== ctx.provider.id) throw outsideDomains();
  if (organizationClosed(domain.organization)) {
    throw new BadRequestError(
      "invalidValue",
      "The email domain's organization is archived or inactive"
    );
  }
  const placement = await domainPlacement(ctx.provider.id, domain.id, tx);
  const user = await createUserInOrganizationTx(
    tx,
    SYSTEM_ACTOR,
    {
      email: input.email,
      name: input.name ?? null,
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
    },
    placement,
    auditMetadata(ctx),
    { scimConnectionId: ctx.connection.id }
  );
  const link = await db.scim.createLink(
    {
      connectionId: ctx.connection.id,
      userId: user.id,
      externalId: input.externalId ?? null,
      userName: input.userName,
      idpActive: input.active ?? true,
      adminHold: false,
    },
    tx
  );
  return { user, link, activeChange: activeChangeOf(user, link) };
};

/** Revives this connection's deleted link, or adopts an unmanaged, visible user. */
const claimTx = async (
  tx: Tx,
  ctx: ScimContext,
  userId: string,
  input: ScimUserInput & { email: string }
): Promise<Applied> => {
  // Only this connection's own deleted link is revived outside its domains;
  // any other account there gets the answer an absent one gets, and no lock.
  const prior = await db.scim.getLinkByUser(userId, tx);
  const revivable =
    prior?.connectionId === ctx.connection.id && prior.deletedAt !== null;
  if (
    !revivable &&
    !(await providerDomains(ctx, tx)).includes(emailDomain(input.email))
  ) {
    throw outsideDomains();
  }
  await db.users.lockForSignInChange(userId, tx);
  const user = await db.users.get(userId, tx);
  // An admin may have changed the address since it was looked up.
  if (user.email !== input.email) throw uniqueness();
  const existing = await db.scim.getLinkByUser(userId, tx);
  if (existing) {
    if (
      existing.connectionId !== ctx.connection.id ||
      existing.deletedAt === null
    ) {
      throw uniqueness();
    }
    const link = await db.scim.updateLink(existing.id, { deletedAt: null }, tx);
    return await applyUserInputTx(tx, ctx, { user, link }, input);
  }
  if (!(await findVisible(ctx, userId, tx))) throw uniqueness();
  const link = await adoptTx(tx, ctx, user, input);
  return await applyUserInputTx(tx, ctx, { user, link }, input);
};

// users.email, scim_users.user_id and the connection's partial indexes on
// external_id and lower(user_name), as the adapter or Prisma names them.
const SCIM_UNIQUE_COLUMNS = new Set([
  "email",
  "userid",
  "connectionexternalid",
  "connectionusername",
]);

const isScimUniqueness = (err: unknown): boolean => {
  const fields = uniqueViolationFields(err);
  if (!fields) return false;
  const key = fields.join("").replace(/_/g, "").toLowerCase();
  return SCIM_UNIQUE_COLUMNS.has(key);
};

export const createScimUser = async (
  ctx: ScimContext,
  input: ScimUserInput
): Promise<Applied> => {
  const { email, userName } = input;
  if (email === undefined || userName === undefined) {
    throw new BadRequestError(
      "invalidValue",
      "userName and an email address are required"
    );
  }
  try {
    return await db.$transaction(async (tx) => {
      const conflict = await db.scim.findLiveConflict(
        ctx.connection.id,
        { email, userName, externalId: input.externalId ?? null },
        tx
      );
      if (conflict) throw uniqueness();
      const existing = await db.users.getByEmail(email, tx);
      return existing
        ? await claimTx(tx, ctx, existing.id, { ...input, email })
        : await createTx(tx, ctx, { ...input, email, userName });
    });
  } catch (err) {
    if (isScimUniqueness(err)) throw uniqueness();
    throw err;
  }
};
