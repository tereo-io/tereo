import { SYSTEM_USER, SYSTEM_USER_ID } from "../../definitions/index.js";
import type { Prisma } from "../../../prisma/generated/client/index.js";
import type { AuthContext } from "../../middleware/auth.js";
import { uniqueViolationFields } from "../prismaErrors.js";
import { emailDomain, normalizeEmail } from "../email.js";
import { assertAdminRemains } from "../adminGuard.js";
import type { ScimUserInput } from "./mapping.js";
import type { ScimUserLink } from "../db/scim.js";
import { assertMayGrantScim } from "./tokens.js";
import type { ScimContext } from "./context.js";
import type { ScimFilter } from "./filter.js";
import { logAuditTx } from "../outbox.js";
import db from "../db/index.js";
import {
  domainPlacement,
  organizationClosed,
} from "../identityProviders/placement.js";
import {
  createUserInOrganizationTx,
  deactivateUser,
  reactivateUser,
  updateUserProfileTx,
  type Actor,
  type UserRow,
  type UserProfile,
} from "../userLifecycle.js";
import {
  BadRequestError,
  ConflictError,
  ManagedByScimError,
  NotFoundError,
} from "../errors.js";

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

type LinkState = Pick<ScimUserLink, "idpActive" | "adminHold">;

type LinkData = Parameters<typeof db.scim.updateLink>[1];

// One answer for every account SCIM may not have, whichever the reason.
const uniqueness = () =>
  new ConflictError(
    "A user with this userName, externalId or email already exists",
    "uniqueness"
  );

const notFound = () => new NotFoundError("User not found");

const auditMetadata = (ctx: ScimContext) => ({
  scimConnectionId: ctx.connection.id,
  providerId: ctx.provider.id,
});

/** What the managed user's `is_active` should become: `idp_active AND NOT admin_hold`. */
const activeChangeOf = (
  user: Pick<UserRow, "isActive">,
  link: LinkState
): ActiveChange => {
  const active = link.idpActive && !link.adminHold;
  if (active === user.isActive) return null;
  return active ? "reactivate" : "deactivate";
};

// An inactive user was deactivated by an admin: the IdP's first sync must
// not bring them back.
const adoptedState = (user: Pick<UserRow, "isActive">): LinkState => ({
  idpActive: user.isActive,
  adminHold: !user.isActive,
});

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
  const link = await db.scim.createLink(
    {
      connectionId: ctx.connection.id,
      userId: user.id,
      externalId: input.externalId ?? null,
      userName: input.userName ?? user.email,
      ...adoptedState(user),
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

const nameChanges = (user: UserRow, input: ScimUserInput): UserProfile => {
  const profile: UserProfile = {};
  for (const key of ["name", "firstName", "lastName"] as const) {
    const value = input[key];
    if (value !== undefined && value !== user[key]) profile[key] = value;
  }
  return profile;
};

// The same whether or not an account has the address.
const outsideDomains = () =>
  new BadRequestError(
    "invalidValue",
    "The email address is not in one of the provider's domains"
  );

// The domain is decided before the lookup, so an outside address answers
// the same whether or not an account has it.
const emailChange = async (
  ctx: ScimContext,
  user: UserRow,
  input: ScimUserInput,
  tx?: Tx
): Promise<string | undefined> => {
  if (input.email === undefined) return undefined;
  const email = normalizeEmail(input.email);
  if (email === user.email) return undefined;
  if (!(await providerDomains(ctx, tx)).includes(emailDomain(email))) {
    throw outsideDomains();
  }
  if (await db.users.getByEmail(email, tx)) throw uniqueness();
  return email;
};

const linkChanges = (
  link: Pick<ScimUserLink, "userName" | "externalId" | "idpActive">,
  input: ScimUserInput
): LinkData => {
  const data: LinkData = {};
  if (input.userName !== undefined && input.userName !== link.userName) {
    data.userName = input.userName;
  }
  if (input.externalId !== undefined && input.externalId !== link.externalId) {
    data.externalId = input.externalId;
  }
  if (input.active !== undefined && input.active !== link.idpActive) {
    data.idpActive = input.active;
  }
  return data;
};

/** A write's `deletedAt`: null revives the resource, a date deletes it. */
type Write = {
  input: ScimUserInput;
  deletedAt?: Date | null;
  auditMetadata?: Record<string, unknown>;
};

const writeLinkTx = async (
  tx: Tx,
  ctx: ScimContext,
  target: Visible,
  write: Write
): Promise<ScimUserLink> => {
  const link =
    target.link ?? (await adoptTx(tx, ctx, target.user, write.input));
  const data = linkChanges(link, write.input);
  if (write.deletedAt !== undefined && write.deletedAt !== link.deletedAt) {
    data.deletedAt = write.deletedAt;
  }
  if (Object.keys(data).length === 0) return link;
  return await db.scim.updateLink(link.id, data, tx);
};

class StaleTarget extends ConflictError {
  constructor() {
    super("The user changed while this request ran; send it again");
  }
}

const sameRows = (a: Visible, b: Visible): boolean =>
  JSON.stringify(a.user) === JSON.stringify(b.user) &&
  JSON.stringify(a.link) === JSON.stringify(b.link);

/**
 * Applies `write` to `target`, as read without a lock. `relock` takes the
 * user's row lock and reads the target again; the write goes ahead only when
 * nothing changed in between, so the profile and the activation change
 * decided from the first read still hold. A deactivation or reactivation
 * runs in the shared lifecycle's own transaction, which takes the last-admin
 * lock before the user's row: the link and profile writes join it, so a
 * refused deactivation leaves all of them undone.
 */
const settle = async (
  ctx: ScimContext,
  target: Visible,
  write: Write,
  relock: (tx: Tx) => Promise<Visible>
): Promise<Visible> => {
  const { user } = target;
  const profile = nameChanges(user, write.input);
  const email = await emailChange(ctx, user, write.input);
  if (email !== undefined) profile.email = email;
  const before = target.link ?? adoptedState(user);
  const change = activeChangeOf(user, {
    adminHold: before.adminHold,
    idpActive: write.input.active ?? before.idpActive,
  });
  const metadata = { ...auditMetadata(ctx), ...write.auditMetadata };

  const recheck = async (tx: Tx) => {
    if (!sameRows(await relock(tx), target)) throw new StaleTarget();
    await emailChange(ctx, user, write.input, tx);
  };
  let link: ScimUserLink | undefined;
  const writeLink = async (tx: Tx) => {
    link = await writeLinkTx(tx, ctx, target, write);
  };

  if (change === "deactivate") {
    const updated = await deactivateUser(SYSTEM_ACTOR, user, {
      authorize: async (tx) => {
        await assertAdminRemains(null, tx);
        await recheck(tx);
      },
      profile,
      auditMetadata: metadata,
      alsoInTx: writeLink,
    });
    return { user: updated, link: link as ScimUserLink };
  }
  if (change === "reactivate") {
    const updated = await reactivateUser(SYSTEM_ACTOR, user, {
      authorize: recheck,
      profile,
      auditMetadata: metadata,
      alsoInTx: writeLink,
    });
    return { user: updated, link: link as ScimUserLink };
  }
  return await db.$transaction(
    async (tx) => {
      await recheck(tx);
      await writeLink(tx);
      if (Object.keys(profile).length > 0) {
        const updated = await updateUserProfileTx(
          tx,
          SYSTEM_ACTOR,
          user,
          profile,
          { auditMetadata: metadata }
        );
        return { user: updated, link: link as ScimUserLink };
      }
      if (write.auditMetadata) {
        await logAuditTx(tx, {
          auth: SYSTEM_ACTOR,
          action: "UPDATE",
          entityType: "User",
          entityId: user.id,
          entityName: user.email,
          metadata,
        });
      }
      return { user, link: link as ScimUserLink };
    },
    { timeout: 30_000 }
  );
};

const createTx = async (
  tx: Tx,
  ctx: ScimContext,
  input: ScimUserInput & { email: string; userName: string }
): Promise<Visible> => {
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
  const idpActive = input.active ?? true;
  const user = await createUserInOrganizationTx(
    tx,
    SYSTEM_ACTOR,
    {
      email: input.email,
      name: input.name ?? null,
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      isActive: idpActive,
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
      idpActive,
      adminHold: false,
    },
    tx
  );
  return { user, link };
};

/** Revives this connection's deleted link, or adopts an unmanaged, visible user. */
const claim = async (
  ctx: ScimContext,
  userId: string,
  input: ScimUserInput & { email: string; userName: string }
): Promise<Visible> => {
  // Only this connection's own deleted link is revived outside its domains;
  // any other account there gets the answer an absent one gets, and no lock.
  const prior = await db.scim.getLinkByUser(userId);
  // An unlinked row is an admin's exclusion: never revived.
  const revivable =
    prior?.connectionId === ctx.connection.id &&
    prior.deletedAt !== null &&
    prior.unlinkedAt === null;
  if (
    !revivable &&
    !(await providerDomains(ctx)).includes(emailDomain(input.email))
  ) {
    throw outsideDomains();
  }
  if (prior && !revivable) throw uniqueness();
  const user = await db.users.get(userId);
  if (!prior && !(await findVisible(ctx, userId))) throw uniqueness();
  const conflictKey = {
    email: input.email,
    userName: input.userName,
    externalId: input.externalId ?? null,
  };
  // A revived resource is a new one: without `active` it is active, as a
  // created user is. An adopted user keeps what adoption gives them.
  const write: Write = revivable
    ? { input: { ...input, active: input.active ?? true }, deletedAt: null }
    : { input };
  return await settle(ctx, { user, link: prior }, write, async (tx) => {
    await db.users.lockForSignInChange(userId, tx);
    if (await db.scim.findLiveConflict(ctx.connection.id, conflictKey, tx)) {
      throw uniqueness();
    }
    const locked = await db.users.get(userId, tx);
    // An admin may have changed the address since it was looked up.
    if (locked.email !== input.email) throw uniqueness();
    const link = await db.scim.getLinkByUser(userId, tx);
    if (!link && !(await findVisible(ctx, userId, tx))) throw uniqueness();
    return { user: locked, link };
  });
};

// users.email, scim_users.user_id and the connection's indexes on
// external_id and user_name_key, as the adapter or Prisma names them.
const SCIM_UNIQUE_COLUMNS = new Set([
  "email",
  "userid",
  "connectionexternalid",
  "connectionusername",
  "connectionidusernamekey",
]);

const isScimUniqueness = (err: unknown): boolean => {
  const fields = uniqueViolationFields(err);
  if (!fields) return false;
  const key = fields.join("").replace(/_/g, "").toLowerCase();
  return SCIM_UNIQUE_COLUMNS.has(key);
};

const ATTEMPTS = 3;

/** Runs `write` again from its first read when its target changed under it. */
const scimWrite = async <T>(write: () => Promise<T>): Promise<T> => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await write();
    } catch (err) {
      if (err instanceof StaleTarget && attempt < ATTEMPTS) continue;
      if (isScimUniqueness(err)) throw uniqueness();
      throw err;
    }
  }
};

export const createScimUser = async (
  ctx: ScimContext,
  input: ScimUserInput
): Promise<Visible> => {
  const { email, userName } = input;
  if (email === undefined || userName === undefined) {
    throw new BadRequestError(
      "invalidValue",
      "userName and an email address are required"
    );
  }
  const conflictKey = {
    email,
    userName,
    externalId: input.externalId ?? null,
  };
  return await scimWrite(async () => {
    if (await db.scim.findLiveConflict(ctx.connection.id, conflictKey)) {
      throw uniqueness();
    }
    const existing = await db.users.getByEmail(email);
    if (existing) {
      return await claim(ctx, existing.id, { ...input, email, userName });
    }
    return await db.$transaction(async (tx) => {
      if (await db.scim.findLiveConflict(ctx.connection.id, conflictKey, tx)) {
        throw uniqueness();
      }
      return await createTx(tx, ctx, { ...input, email, userName });
    });
  });
};

const relockVisible =
  (ctx: ScimContext, userId: string) =>
  async (tx: Tx): Promise<Visible> => {
    await db.users.lockForSignInChange(userId, tx);
    const found = await findVisible(ctx, userId, tx);
    if (!found) throw notFound();
    return found;
  };

/** Adopts an unmanaged visible user first. */
const updateScimUser = async (
  ctx: ScimContext,
  userId: string,
  input: ScimUserInput
): Promise<Visible> =>
  await scimWrite(async () => {
    // An invisible user is refused before any lock is taken.
    const found = await findVisible(ctx, userId);
    if (!found) throw notFound();
    return await settle(ctx, found, { input }, relockVisible(ctx, userId));
  });

export const replaceScimUser = updateScimUser;

export const patchScimUser = updateScimUser;

/**
 * Records the IdP's `active` on a managed user and acts on it, unless an
 * admin's hold keeps the user inactive.
 */
export const setIdpActive = async (
  ctx: ScimContext,
  target: { user: UserRow; link: ScimUserLink },
  active: boolean
): Promise<UserRow> => {
  const { user } = await scimWrite(async () =>
    settle(
      ctx,
      target,
      { input: { active } },
      relockVisible(ctx, target.user.id)
    )
  );
  return user;
};

/**
 * The IdP's "this person should no longer have access": an unmanaged user is
 * adopted first. The user and link rows stay; the resource answers 404 after.
 */
export const deleteScimUser = async (
  ctx: ScimContext,
  userId: string
): Promise<void> => {
  await scimWrite(async () => {
    const found = await findVisible(ctx, userId);
    if (!found) throw notFound();
    return await settle(
      ctx,
      found,
      {
        input: { active: false },
        deletedAt: new Date(),
        auditMetadata: { action: "scim_deleted" },
      },
      relockVisible(ctx, userId)
    );
  });
};

/**
 * Refuses an admin change to what the IdP owns: the profile, and a
 * reactivation while the IdP has the user inactive. A deleted link still
 * counts until an admin unlinks the user; an unlinked one does not.
 */
export const assertScimAllows = (
  link: ScimUserLink | null,
  change: { profile: boolean; reactivating: boolean }
): void => {
  if (!link || link.unlinkedAt !== null) return;
  if (change.profile) throw new ManagedByScimError();
  if (change.reactivating && !link.idpActive) {
    throw new ManagedByScimError(
      "The identity provider has this user deactivated; reactivate them there"
    );
  }
};

/**
 * Sets the admin's hold on a managed user who is already inactive; the
 * caller holds the user's row lock. A link-only write: `is_active` stays
 * false either way.
 */
export const holdScimUserTx = async (
  tx: Tx,
  auth: Actor,
  userId: string
): Promise<void> => {
  const link = await db.scim.getManagingLink(userId, tx);
  if (!link || link.adminHold) return;
  const user = await db.users.get(userId, tx);
  // Reactivated since the caller read them: the hold alone would leave them
  // active against the invariant.
  if (user.isActive) {
    throw new ConflictError(
      "The user was reactivated while this request ran; send it again"
    );
  }
  await db.scim.updateLink(link.id, { adminHold: true }, tx);
  const connection = await db.scim.getConnection(link.connectionId, tx);
  await logAuditTx(tx, {
    auth,
    action: "UPDATE",
    entityType: "User",
    entityId: user.id,
    entityName: user.email,
    metadata: {
      action: "scim_admin_hold",
      scimConnectionId: link.connectionId,
      providerId: connection.providerId,
    },
  });
};

/**
 * The user is then managed locally and excluded from SCIM until released;
 * their state, active or not, is kept. The row stays as that exclusion.
 */
export const unlinkScimUser = async (
  auth: AuthContext,
  userId: string
): Promise<void> => {
  await db.$transaction(async (tx) => {
    await db.users.lockForSignInChange(userId, tx);
    const user = await db.users.get(userId, tx);
    const link = await db.scim.getManagingLink(userId, tx);
    if (!link) throw new NotFoundError("User is not managed by SCIM");
    const connection = await db.scim.getConnection(link.connectionId, tx);
    await db.scim.updateLink(
      link.id,
      { unlinkedAt: new Date(), externalId: null },
      tx
    );
    await logAuditTx(tx, {
      auth,
      action: "UPDATE",
      entityType: "User",
      entityId: user.id,
      entityName: user.email,
      metadata: {
        action: "scim_unlinked",
        scimConnectionId: link.connectionId,
        providerId: connection.providerId,
      },
    });
  });
};

/**
 * Ends an unlinked user's exclusion: the IdP's next write adopts them as it
 * would any unmanaged user, and with them the provider's sign-in power over
 * the account, so it needs the authority enabling SCIM does.
 */
export const releaseScimUser = async (
  auth: AuthContext,
  userId: string
): Promise<void> => {
  await db.$transaction(async (tx) => {
    await assertMayGrantScim(auth, tx);
    await db.users.lockForSignInChange(userId, tx);
    const user = await db.users.get(userId, tx);
    const link = await db.scim.getLinkByUser(userId, tx);
    if (!link || link.unlinkedAt === null) {
      throw new NotFoundError("User is not excluded from SCIM");
    }
    const connection = await db.scim.getConnection(link.connectionId, tx);
    await db.scim.deleteLink(link.id, tx);
    await logAuditTx(tx, {
      auth,
      action: "UPDATE",
      entityType: "User",
      entityId: user.id,
      entityName: user.email,
      metadata: {
        action: "scim_released",
        scimConnectionId: link.connectionId,
        providerId: connection.providerId,
      },
    });
  });
};
