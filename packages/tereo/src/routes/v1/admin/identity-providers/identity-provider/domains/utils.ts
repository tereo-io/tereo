import { getDefaultOrganizationId } from "../../../../../../utils/defaultOrganization.js";
import type { Prisma } from "../../../../../../../prisma/generated/client/index.js";
import { formatDomain } from "../../../../../../utils/identityProviders/format.js";
import { recordSessionsRevoked } from "../../../../../../utils/sessionEvents.js";
import type { AuthContext } from "../../../../../../middleware/auth.js";
import { assertGlobalAdmin } from "../../../../../../utils/grants.js";
import { endUserSessions } from "../../../../../../utils/sessions.js";
import { emitTx } from "../../../../../../utils/outbox.js";
import { logger } from "../../../../../../utils/logger.js";
import db from "../../../../../../utils/db/index.js";
import {
  ConflictError,
  NotFoundError,
} from "../../../../../../utils/errors.js";

/**
 * SSO-only on an inactive provider would leave the domain no way to sign in.
 * Holds the provider's row lock for the rest of `tx`, so a concurrent
 * deactivation waits and then sees this domain.
 */
export const assertProviderActive = async (
  providerId: string,
  tx: Prisma.TransactionClient
) => {
  const provider = await db.identityProviders.lockForUpdate(providerId, tx);
  if (!provider.isActive) {
    throw new ConflictError(
      "The provider is inactive; activate it before making a domain SSO-only",
      "provider_inactive"
    );
  }
};

/**
 * A password login at an SSO-only domain is force-linked to its provider and
 * the password dropped, so whoever runs the provider gets those accounts:
 * turning it on, or pointing it at another domain, hands them over, and
 * turning it off (or deleting the domain) reopens them to passwords. Neither
 * is bounded by any permission the caller holds, so only a global `admin`.
 */
export const changesSsoOnly = (
  row: { ssoOnly: boolean; domain: string },
  body: { ssoOnly?: boolean; domain?: string }
) => {
  const after = body.ssoOnly ?? row.ssoOnly;
  if (after !== row.ssoOnly) return true;
  return after && body.domain !== undefined && body.domain !== row.domain;
};

export const assertMayChangeSsoOnly = (
  auth: Pick<AuthContext, "userId" | "ceiling">,
  tx: Prisma.TransactionClient
) =>
  assertGlobalAdmin(
    auth,
    "Only an administrator (global admin) can make a domain SSO-only, move an SSO-only domain or lift SSO-only",
    tx
  );

type DomainEvent =
  | "auth.identity-provider.domain-created"
  | "auth.identity-provider.domain-updated";

export const emitDomainTx = (
  tx: Prisma.TransactionClient,
  eventType: DomainEvent,
  providerId: string,
  domain: Parameters<typeof formatDomain>[0]
) =>
  emitTx(tx, {
    organizationId: getDefaultOrganizationId(),
    eventType,
    entityType: "IdentityProviderDomain",
    entityId: domain.id,
    data: { providerId, ...formatDomain(domain) },
  });

/**
 * Once a domain is SSO-only its provider is its users' only way in, so a
 * session from an identity at another provider must not outlive the change.
 * Run after the domain's change commits; each user's sessions end, audited
 * and emitted, in their own transaction. It reads the domain as it is now,
 * so running it again ends only what is left, and nothing once the domain
 * is no longer SSO-only. One user's failure is logged and does not stop the
 * rest.
 */
export const endSessionsLinkedElsewhere = async (
  auth: { userId: string; email: string | null },
  providerId: string,
  domainId: string
) => {
  const domain = await db.identityProviders
    .getDomain(providerId, domainId)
    .catch((err) => {
      if (err instanceof NotFoundError) return null;
      throw err;
    });
  if (!domain?.ssoOnly) return;
  const users = await db.userIdentities.usersAtDomainLinkedElsewhere(
    domain.domain,
    providerId
  );
  for (const user of users) {
    try {
      await endUserSessions(user.id, null, recordSessionsRevoked(auth, user));
    } catch (err) {
      logger.error(
        { err, userId: user.id, providerId, domainId },
        "Could not end the sessions of a user at an SSO-only domain"
      );
    }
  }
};
