import { getDefaultOrganizationId } from "./defaultOrganization.js";
import type { RecordRevocation } from "./sessions.js";
import { emitTx, logAuditTx } from "./outbox.js";

/**
 * Records sessions revoked through the account or admin API, in the
 * revoking transaction: an audit entry naming who revoked them and an
 * `auth.user.sessions-revoked` event, each listing every refresh token
 * revoked and SSO session ended. Nothing when none were revoked. A user
 * revoking their own (`self`, the account API) is a LOGOUT; an admin's
 * revoke is an UPDATE of that user.
 */
export const recordSessionsRevoked =
  (
    auth: { userId: string; email: string | null },
    user: { id: string; email: string },
    { self = false }: { self?: boolean } = {}
  ): RecordRevocation =>
  async (tx, sessionIds, ssoSessionIds) => {
    if (sessionIds.length === 0 && ssoSessionIds.length === 0) return;
    await logAuditTx(tx, {
      auth,
      action: self ? "LOGOUT" : "UPDATE",
      entityType: "User",
      entityId: user.id,
      entityName: user.email,
      metadata: {
        action: "sessions_revoked",
        sessionIds,
        ssoSessionIds,
        ...(self && { method: "account" }),
      },
    });
    await emitTx(tx, {
      organizationId: getDefaultOrganizationId(),
      eventType: "auth.user.sessions-revoked",
      entityType: "User",
      entityId: user.id,
      data: { userId: user.id, email: user.email, sessionIds, ssoSessionIds },
    });
  };
