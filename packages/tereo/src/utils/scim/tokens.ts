import type { Prisma } from "../../../prisma/generated/client/index.js";
import type { AuthContext } from "../../middleware/auth.js";
import { createHash, randomBytes } from "node:crypto";
import { assertGlobalAdmin } from "../grants.js";

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
  tx?: Prisma.TransactionClient
) =>
  assertGlobalAdmin(
    auth,
    "Only an administrator (global admin) can enable SCIM for a provider or issue its tokens",
    tx
  );
