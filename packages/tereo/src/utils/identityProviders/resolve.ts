import { SYSTEM_USER, SYSTEM_USER_ID } from "../../definitions/index.js";
import type { IdentityProvider, NormalizedIdentity } from "./types.js";
import { emitTx, logAuditTx, type AuditLogInput } from "../outbox.js";
import { getDefaultOrganizationId } from "../defaultOrganization.js";
import { uniqueViolationFields } from "../prismaErrors.js";
import { emailDomain, normalizeEmail } from "../email.js";
import { formatUser } from "../transformers.js";
import type { Prisma } from "../db/prisma.js";
import { logger } from "../logger.js";
import db from "../db/index.js";

type Tx = Prisma.TransactionClient;

export type AuditActor = AuditLogInput["auth"];

export type ResolveFailure =
  "no_account" | "account_exists" | "email_unverified";

export type Resolution = { userId: string } | { error: ResolveFailure };

const GOOGLE_ISSUER = "https://accounts.google.com";
// Google is the authority for its own consumer domains, which carry no `hd`.
const GOOGLE_CONSUMER_DOMAINS = new Set(["gmail.com", "googlemail.com"]);
const NAME_MAX = 100;

const SYSTEM_ACTOR: AuditActor = {
  userId: SYSTEM_USER_ID,
  email: SYSTEM_USER.email,
};

const isGoogle = (provider: IdentityProvider): boolean =>
  provider.issuer?.replace(/\/+$/, "") === GOOGLE_ISSUER;

/**
 * Whether the provider vouches for `email` belonging to this person. Google
 * marks a consumer account's email verified even at a Workspace domain, so
 * there the `hd` claim must name the domain too.
 */
export const emailTrusted = (
  provider: IdentityProvider,
  identity: NormalizedIdentity,
  email: string,
  match: "invite" | "domain"
): boolean => {
  if (!identity.emailVerified) return false;
  if (!isGoogle(provider)) return true;
  const domain = emailDomain(email);
  if (identity.hostedDomain?.toLowerCase() === domain) return true;
  return (
    match === "invite" &&
    identity.hostedDomain === null &&
    GOOGLE_CONSUMER_DOMAINS.has(domain)
  );
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
  await db.userIdentities.touchLogin(
    linked.id,
    identity.email === null ? null : normalizeEmail(identity.email)
  );
  return { userId: linked.userId };
};

const resolveOnce = async (
  provider: IdentityProvider,
  identity: NormalizedIdentity
): Promise<Resolution> => {
  const linked = await signInLinked(provider, identity);
  if (linked) return linked;

  if (identity.email === null) return { error: "no_account" };
  const email = normalizeEmail(identity.email);

  const invite = await db.userIdentities.findInvite(provider.id, email);
  if (invite) {
    if (!emailTrusted(provider, identity, email, "invite")) {
      return { error: "email_unverified" };
    }
    // One account per provider per user: the invite is not this subject's to claim.
    if (
      await db.userIdentities.getForUserAtProvider(invite.userId, provider.id)
    ) {
      return { error: "account_exists" };
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

  const domain = await db.identityProviders.findDomain(emailDomain(email));
  if (!domain || domain.providerId !== provider.id || !domain.autoAccept) {
    return { error: "no_account" };
  }
  if (domain.organization.archivedAt || !domain.organization.isActive) {
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
  const domain = await db.identityProviders.getDomain(provider.id, domainId);
  const orgId = domain.organizationId;
  // A default role archived or retired since it was chosen is not granted.
  const roles = await db.roles.getByIds(domain.roles.map((r) => r.role.id));
  const roleIds = roles.map((r) => r.id);

  return await db.$transaction(async (tx) => {
    const firstName = clip(identity.firstName);
    const lastName = clip(identity.lastName);
    const user = await db.users.createWithoutPassword(
      {
        email,
        name:
          clip(identity.name) ??
          clip([firstName, lastName].filter(Boolean).join(" ")),
        firstName,
        lastName,
      },
      tx
    );
    await logAuditTx(tx, {
      auth: SYSTEM_ACTOR,
      action: "CREATE",
      entityType: "User",
      entityId: user.id,
      entityName: user.email,
      metadata: {
        email: user.email,
        name: user.name,
        userType: user.userType,
        providerId: provider.id,
      },
    });
    await emitTx(tx, {
      organizationId: getDefaultOrganizationId(),
      eventType: "auth.user.created",
      entityType: "User",
      entityId: user.id,
      data: formatUser(user) as unknown as Record<string, unknown>,
    });

    const member = await db.organizations.addMember(
      orgId,
      user.id,
      "member",
      tx
    );
    await logAuditTx(tx, {
      auth: SYSTEM_ACTOR,
      organizationId: orgId,
      action: "CREATE",
      entityType: "OrganizationMember",
      entityId: member.id,
      entityName: user.email,
      metadata: { userId: user.id, memberRole: member.memberRole },
    });
    await emitTx(tx, {
      organizationId: getDefaultOrganizationId(),
      eventType: "auth.organization.member-added",
      entityType: "OrganizationMember",
      entityId: member.id,
      data: {
        organizationId: orgId,
        userId: user.id,
        email: user.email,
        memberRole: member.memberRole,
      },
    });

    if (roleIds.length > 0) {
      await db.organizations.setMemberRoles(orgId, user.id, roleIds, tx);
      await logAuditTx(tx, {
        auth: SYSTEM_ACTOR,
        organizationId: orgId,
        action: "UPDATE",
        entityType: "OrganizationMember",
        entityId: member.id,
        entityName: user.email,
        metadata: { action: "roles_changed", userId: user.id, roleIds },
      });
      await emitTx(tx, {
        organizationId: getDefaultOrganizationId(),
        eventType: "auth.organization.member-roles-changed",
        entityType: "OrganizationMember",
        entityId: member.id,
        data: {
          organizationId: orgId,
          userId: user.id,
          email: user.email,
          roleIds,
        },
      });
    }

    await linkIdentity(tx, SYSTEM_ACTOR, user.id, provider, identity);
    return user.id;
  });
};

export const linkIdentity = async (
  tx: Tx,
  auth: AuditActor,
  userId: string,
  provider: IdentityProvider,
  identity: NormalizedIdentity
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
  return created;
};
