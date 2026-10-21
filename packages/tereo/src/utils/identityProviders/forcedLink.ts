import type { IdentityProvider, NormalizedIdentity } from "./types.js";
import { getDefaultOrganizationId } from "../defaultOrganization.js";
import { recordSessionsRevoked } from "../sessionEvents.js";
import { uniqueViolationFields } from "../prismaErrors.js";
import type { StepWriter } from "../db/loginFlows.js";
import { emitTx, logAuditTx } from "../outbox.js";
import { endUserSessions } from "../sessions.js";
import type { Prisma } from "../db/prisma.js";
import { linkIdentity } from "./resolve.js";
import { OAuth2Error } from "../errors.js";
import { emailDomain } from "../email.js";
import db from "../db/index.js";

type Tx = Prisma.TransactionClient;

export type ForcedLinkRefusal =
  "session_expired" | "identity_in_use" | "already_linked";

export class ForcedLinkRefused extends Error {
  constructor(public code: ForcedLinkRefusal) {
    super(code);
  }
}

/**
 * Links the identity an SSO-only user's provider vouched for, clears their
 * password, consumes the link grant and ends their sessions, as a password
 * reset does, in one transaction. `consume` runs first in it, for the step
 * that led here; `login`, when given, records the provider login too.
 * Throws ForcedLinkRefused when the grant is gone, the domain no longer
 * requires this provider, or the identity was taken meanwhile.
 */
export const commitForcedLink = async ({
  user,
  provider,
  identity,
  linkGrantId,
  consume,
  login,
}: {
  user: Awaited<ReturnType<typeof db.users.get>>;
  provider: IdentityProvider;
  identity: Pick<NormalizedIdentity, "subject" | "email">;
  linkGrantId: string;
  consume?: (tx: Tx) => Promise<void>;
  login?: { clientId: string; authMethods: string[] };
}): Promise<{ id: string }> => {
  const auth = { userId: user.id, email: user.email };
  let linked: { id: string } | undefined;
  try {
    await endUserSessions(
      user.id,
      null,
      async (tx, sessionIds, ssoSessionIds) => {
        // Before the grant: consuming it takes a pending step with it.
        await consume?.(tx);
        await db.users.lockForSignInChange(user.id, tx);
        const domain = await db.identityProviders.findDomain(
          emailDomain(user.email),
          tx
        );
        if (!domain?.ssoOnly || domain.providerId !== provider.id) {
          throw new ForcedLinkRefused("session_expired");
        }
        if (!(await db.upstreamAuth.consumeLinkGrant(linkGrantId, tx))) {
          throw new ForcedLinkRefused("session_expired");
        }
        linked = await linkIdentity(tx, auth, user.id, provider, identity);
        await db.users.clearPassword(user.id, tx);
        await logAuditTx(tx, {
          auth,
          action: "UPDATE",
          entityType: "User",
          entityId: user.id,
          entityName: user.email,
          metadata: {
            passwordRemoved: true,
            reason: "sso_only",
            provider: provider.slug,
          },
        });
        await emitTx(tx, {
          organizationId: getDefaultOrganizationId(),
          eventType: "auth.user.password-changed",
          entityType: "User",
          entityId: user.id,
          data: { userId: user.id, email: user.email, reason: "sso_only" },
        });
        if (login) {
          await logAuditTx(tx, {
            auth,
            action: "LOGIN",
            entityType: "UserIdentity",
            entityId: linked.id,
            entityName: user.email,
            metadata: {
              provider: provider.slug,
              auth_methods: login.authMethods,
              client_id: login.clientId,
            },
          });
        }
        await recordSessionsRevoked(auth, user)(tx, sessionIds, ssoSessionIds);
      }
    );
  } catch (err) {
    const fields = uniqueViolationFields(err);
    if (!fields) throw err;
    throw new ForcedLinkRefused(
      fields.some((f) => /subject/i.test(f))
        ? "identity_in_use"
        : "already_linked"
    );
  }
  return linked!;
};

/**
 * The step writer for a TOTP step that passed (`consume` spends it). A step
 * holding a forced link commits the link first, spending the step in the
 * same transaction, so the link, the password's removal and the sign-out
 * happen only once the second factor is in.
 */
export const writeStepAfterSecondFactor = async (
  verification: {
    userId: string;
    pendingLinkId: string | null;
    firstFactor: string[];
  },
  clientId: string,
  consume: (tx: Tx) => Promise<void>
): Promise<StepWriter> => {
  const { userId, pendingLinkId } = verification;
  if (!pendingLinkId) return db.loginFlows.writeStepConsuming(userId, consume);

  const sessionGone = () =>
    new OAuth2Error(
      "invalid_session",
      "Session not found. Please login again."
    );
  // Gone with its grant, and the step with it.
  const pending = await db.upstreamAuth.getPendingLink(pendingLinkId);
  if (!pending) throw sessionGone();
  const provider = await db.identityProviders.get(pending.providerId);
  if (!provider.isActive) throw sessionGone();
  try {
    await commitForcedLink({
      user: await db.users.get(userId),
      provider,
      identity: pending,
      linkGrantId: pending.linkGrantId,
      consume,
      login: { clientId, authMethods: verification.firstFactor },
    });
  } catch (err) {
    if (err instanceof ForcedLinkRefused) throw sessionGone();
    throw err;
  }
  return db.loginFlows.writeStep;
};
