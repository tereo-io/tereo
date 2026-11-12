import type { Prisma } from "../../../prisma/generated/client/index.js";
import type { AuthContext } from "../../middleware/auth.js";
import { createHash, randomBytes } from "node:crypto";
import { assertGlobalAdmin } from "../grants.js";
import db from "../db/index.js";

export const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");

export const mintToken = () => {
  const token = `scim_${randomBytes(32).toString("base64url")}`;
  return { token, hash: hashToken(token) };
};

/**
 * A SCIM connection lets its provider sign in as any user it adopts in its
 * domains, the power `ssoOnly` grants, so it needs the same authority.
 */
export const assertMayGrantScim = (
  auth: Pick<AuthContext, "userId" | "ceiling">,
  tx?: Prisma.TransactionClient,
  refusal = "Only an administrator (global admin) can enable SCIM for a provider or issue its tokens"
) => assertGlobalAdmin(auth, refusal, tx);

/**
 * The same power changes hands when a provider with a SCIM connection (active
 * or not) is pointed at another issuer, client or secret, gains a domain, or
 * is reactivated: whoever runs the result signs in as the users it manages.
 * Callers hold the provider's row lock, which creating a connection takes.
 */
export const assertMayRedirectScim = async (
  auth: Pick<AuthContext, "userId" | "ceiling">,
  providerId: string,
  refusal: string,
  tx?: Prisma.TransactionClient
) => {
  if (!(await db.scim.getConnectionByProvider(providerId, tx))) return;
  await assertMayGrantScim(auth, tx, refusal);
};
