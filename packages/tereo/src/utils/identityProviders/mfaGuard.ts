import type { AuthContext } from "../../middleware/auth.js";
import { globalGrantablePermissions } from "../grants.js";
import { hasPermission } from "../permissions.js";
import { ForbiddenError } from "../errors.js";

/**
 * A provider login that counts as multi-factor satisfies every 2FA policy,
 * `admin`'s included, so only a global `admin` may turn it on.
 */
export const assertMayCountAsMfa = async (
  auth: Pick<AuthContext, "userId" | "ceiling">
) => {
  if (!hasPermission(await globalGrantablePermissions(auth), "admin")) {
    throw new ForbiddenError(
      "Only an administrator (global admin) can make a provider's logins count as multi-factor"
    );
  }
};
