import { SYSTEM_USER, SYSTEM_USER_ID } from "../../definitions/index.js";
import type { IdentityProvider, NormalizedIdentity } from "./types.js";
import { emitTx, logAuditTx, type AuditLogInput } from "../outbox.js";
import { getDefaultOrganizationId } from "../defaultOrganization.js";
import { domainPlacement, organizationClosed } from "./placement.js";
import { createUserInOrganizationTx } from "../userLifecycle.js";
import { uniqueViolationFields } from "../prismaErrors.js";
import { emailDomain, normalizeEmail } from "../email.js";
import { markVerifiedFromProvider } from "./verify.js";
import type { ScimUserLink } from "../db/scim.js";
import { isUsableAccount } from "../users.js";
import type { Prisma } from "../db/prisma.js";
import { emailTrusted } from "./trust.js";
import { logger } from "../logger.js";
import db from "../db/index.js";

type Tx = Prisma.TransactionClient;

export type AuditActor = AuditLogInput["auth"];

export type ResolveFailure =
  "no_account" | "account_exists" | "email_unverified";

export type Resolution =
  | { userId: string }
  | { error: ResolveFailure }
  /** The user's domain is SSO-only for `provider`, the only way in. */
  | { error: "sso_required"; provider: IdentityProvider };

const NAME_MAX = 100;

const SYSTEM_ACTOR: AuditActor = {
  userId: SYSTEM_USER_ID,
  email: SYSTEM_USER.email,
};

/**
 * The provider an SSO-only domain requires of `email`, when it is not
 * `providerId`: no other provider signs such a user in or links to them.
 */
export const ssoProviderElsewhere = async (
  email: string,
  providerId: string,
  tx?: Tx
): Promise<IdentityProvider | null> => {
  const domain = await db.identityProviders.findDomain(emailDomain(email), tx);
  return domain?.ssoOnly && domain.providerId !== providerId
    ? domain.provider
    : null;
};

const clip = (value: string | null): string | null =>
  value?.trim().slice(0, NAME_MAX) || null;

/** Never matches an existing account by email: only by subject, an invite, or a new user. */
export const resolveLoginIdentity = async (
  provider: IdentityProvider,
  identity: NormalizedIdentity
): Promise<Resolution> => {
  try {
    return await resolveOnce(provider, identity);
  } catch (err) {
    const fields = uniqueViolationFields(err);
    if (!fields) throw err;
    // A concurrent first sign-in of the same subject linked it first.
    const linked = await signInLinked(provider, identity);
    if (linked) return linked;
    if (sameColumns(fields, ["email"])) return { error: "account_exists" };
    // Another subject claimed the same invite first.
    if (sameColumns(fields, ["user_id", "provider_id"])) {
      return { error: "account_exists" };
    }
    throw err;
  }
};

// The adapter names database columns; tolerate Prisma's field names too.
// `fields` may be one underscore-joined name, as uniqueViolationFields gives
// when the driver names only the index; it is in the index's column order.
const sameColumns = (fields: string[], expected: string[]): boolean => {
  const norm = (f: string) => f.replace(/_/g, "").toLowerCase();
  const got = new Set(fields.map(norm));
  if (got.size === expected.length && expected.every((f) => got.has(norm(f)))) {
    return true;
  }
  return norm(fields.join("")) === norm(expected.join(""));
};

const signInLinked = async (
  provider: IdentityProvider,
  identity: NormalizedIdentity
): Promise<Resolution | null> => {
  const linked = await db.userIdentities.getByProviderSubject(
    provider.id,
    identity.subject
  );
  if (!linked) return null;
  const user = await db.users.get(linked.userId);
  const required = await ssoProviderElsewhere(user.email, provider.id);
  if (required) return { error: "sso_required", provider: required };
  await db.userIdentities.touchLogin(
    linked.id,
    identity.email === null ? null : normalizeEmail(identity.email)
  );
  // A deactivated or expired account is not signed in: the provider's word
  // about it changes nothing.
  if (user.emailVerifiedAt === null && isUsableAccount(user)) {
    await db.$transaction((tx) =>
      markVerifiedFromProvider(tx, { userId: user.id, provider, identity })
    );
  }
  return { userId: linked.userId };
};

type ClaimRule = "objectId" | "email";

/** The one live link a rule finds, or "ambiguous" (logged) when it finds several. */
const claimableBy = async (
  provider: IdentityProvider,
  connectionId: string,
  rule: ClaimRule,
  by: { externalId: string } | { email: string }
): Promise<ScimUserLink | "ambiguous" | null> => {
  const found = await db.scim.findClaimable(connectionId, by);
  if (found.length <= 1) return found[0] ?? null;
  logger.warn(
    { providerId: provider.id, rule, matches: found.length },
    "Several SCIM users match a first sign-in; claiming none"
  );
  return "ambiguous";
};

/**
 * A first sign-in of a user this provider's SCIM connection manages: by
 * Entra's object id as the SCIM `externalId`, else by a trusted email equal
 * to the user's own. Null falls through to the invite lookup.
 */
const claimScimUser = async (
  provider: IdentityProvider,
  identity: NormalizedIdentity
): Promise<Resolution | null> => {
  if (!provider.isActive) return null;
  const connection = await db.scim.getConnectionByProvider(provider.id);
  if (!connection?.isActive) return null;

  let match: ScimUserLink | "ambiguous" | null = null;
  if (identity.objectId !== null) {
    match = await claimableBy(provider, connection.id, "objectId", {
      externalId: identity.objectId,
    });
  }
  if (match === null && identity.email !== null) {
    const email = normalizeEmail(identity.email);
    if (emailTrusted(provider, identity, email, "invite")) {
      match = await claimableBy(provider, connection.id, "email", { email });
    }
  }
  if (match === null || match === "ambiguous") return null;

  const user = await db.users.get(match.userId);
  const required = await ssoProviderElsewhere(user.email, provider.id);
  if (required) return { error: "sso_required", provider: required };
  // One account per provider per user, unless a concurrent sign-in of this
  // subject just linked it.
  if (await db.userIdentities.getForUserAtProvider(user.id, provider.id)) {
    return await signInLinked(provider, identity);
  }
  // Nothing links a deactivated or expired account. Naming it lets the
  // callback refuse it as such; unlinked, it is never signed in.
  if (!isUsableAccount(user)) return { userId: user.id };
  await db.$transaction((tx) =>
    linkIdentity(
      tx,
      { userId: user.id, email: user.email },
      user.id,
      provider,
      identity,
      { via: "scim", scimConnectionId: connection.id }
    )
  );
  return { userId: user.id };
};

const resolveOnce = async (
  provider: IdentityProvider,
  identity: NormalizedIdentity
): Promise<Resolution> => {
  const linked = await signInLinked(provider, identity);
  if (linked) return linked;

  const scim = await claimScimUser(provider, identity);
  if (scim) return scim;

  if (identity.email === null) return { error: "no_account" };
  const email = normalizeEmail(identity.email);

  const invite = await db.userIdentities.findInvite(provider.id, email);
  if (invite) {
    if (!emailTrusted(provider, identity, email, "invite")) {
      return { error: "email_unverified" };
    }
    const required = await ssoProviderElsewhere(invite.user.email, provider.id);
    if (required) return { error: "sso_required", provider: required };
    // One account per provider per user: the invite is not this subject's to
    // claim, unless a concurrent sign-in of this subject just claimed it.
    if (
      await db.userIdentities.getForUserAtProvider(invite.userId, provider.id)
    ) {
      return (
        (await signInLinked(provider, identity)) ?? { error: "account_exists" }
      );
    }
    await db.$transaction((tx) =>
      linkIdentity(
        tx,
        { userId: invite.userId, email: invite.user.email },
        invite.userId,
        provider,
        identity
      )
    );
    return { userId: invite.userId };
  }

  // Claiming deletes the invite: a concurrent sign-in of this subject may have
  // claimed it since the lookup by subject above.
  const claimed = await signInLinked(provider, identity);
  if (claimed) return claimed;

  const domain = await db.identityProviders.findDomain(emailDomain(email));
  if (!domain || domain.providerId !== provider.id || !domain.autoAccept) {
    return { error: "no_account" };
  }
  if (organizationClosed(domain.organization)) {
    logger.warn(
      { domain: domain.domain, organizationId: domain.organizationId },
      "Auto-accept domain's organization is archived or inactive; not provisioning"
    );
    return { error: "no_account" };
  }
  if (!emailTrusted(provider, identity, email, "domain")) {
    return { error: "email_unverified" };
  }
  if (await db.users.getByEmail(email)) return { error: "account_exists" };

  const userId = await provision(provider, identity, email, domain.id);
  return { userId };
};

const provision = async (
  provider: IdentityProvider,
  identity: NormalizedIdentity,
  email: string,
  domainId: string
): Promise<string> => {
  const placement = await domainPlacement(provider.id, domainId);

  return await db.$transaction(async (tx) => {
    const firstName = clip(identity.firstName);
    const lastName = clip(identity.lastName);
    const user = await createUserInOrganizationTx(
      tx,
      SYSTEM_ACTOR,
      {
        email,
        name:
          clip(identity.name) ??
          clip([firstName, lastName].filter(Boolean).join(" ")),
        firstName,
        lastName,
      },
      placement,
      { providerId: provider.id }
    );
    await linkIdentity(tx, SYSTEM_ACTOR, user.id, provider, identity);
    return user.id;
  });
};

export const linkIdentity = async (
  tx: Tx,
  auth: AuditActor,
  userId: string,
  provider: IdentityProvider,
  identity: Pick<NormalizedIdentity, "subject" | "email"> &
    Partial<Pick<NormalizedIdentity, "emailVerified" | "hostedDomain">>,
  auditMetadata: Record<string, string> = {}
): Promise<{ id: string }> => {
  const email = identity.email === null ? null : normalizeEmail(identity.email);
  const created = await db.userIdentities.create(
    { userId, providerId: provider.id, subject: identity.subject, email },
    tx
  );
  await db.userIdentities.deleteInvite(userId, provider.id, tx);
  const user = await db.users.get(userId, tx);
  await logAuditTx(tx, {
    auth,
    action: "CREATE",
    entityType: "UserIdentity",
    entityId: created.id,
    entityName: user.email,
    metadata: {
      ...auditMetadata,
      userId,
      providerId: provider.id,
      provider: provider.slug,
      email,
    },
  });
  await emitTx(tx, {
    organizationId: getDefaultOrganizationId(),
    eventType: "auth.user.identity-linked",
    entityType: "UserIdentity",
    entityId: created.id,
    data: {
      id: created.id,
      userId,
      providerId: provider.id,
      provider: provider.slug,
      email,
      createdAt: created.createdAt.toISOString(),
    },
  });
  // Forced links pass no claims and verify nothing; a later ordinary sign-in
  // through the provider does.
  if (identity.emailVerified !== undefined) {
    await markVerifiedFromProvider(tx, {
      userId,
      provider,
      identity: {
        email: identity.email,
        emailVerified: identity.emailVerified,
        hostedDomain: identity.hostedDomain ?? null,
      },
    });
  }
  return created;
};
