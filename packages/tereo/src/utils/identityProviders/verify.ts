import type { IdentityProvider, NormalizedIdentity } from "./types.js";
import { markEmailVerified } from "../userLinks.js";
import type { Prisma } from "../db/prisma.js";
import { isUsableAccount } from "../users.js";
import { normalizeEmail } from "../email.js";
import { emailTrusted } from "./trust.js";
import db from "../db/index.js";

/**
 * A provider that vouches for the account's own address verifies it. An
 * address that differs, or that the provider does not vouch for, changes
 * nothing, nor does any sign-in of a deactivated or expired account: every
 * provider path (linked sign-in, invite claim, autoAccept, account link)
 * passes through here.
 */
export const markVerifiedFromProvider = async (
  tx: Prisma.TransactionClient,
  {
    userId,
    provider,
    identity,
  }: {
    userId: string;
    provider: IdentityProvider;
    identity: Pick<
      NormalizedIdentity,
      "email" | "emailVerified" | "hostedDomain"
    >;
  }
): Promise<void> => {
  if (identity.email === null) return;
  const user = await db.users.get(userId, tx);
  if (!isUsableAccount(user)) return;
  const email = normalizeEmail(identity.email);
  if (email !== user.email) return;
  if (!emailTrusted(provider, identity, email, "invite")) {
    return;
  }
  await markEmailVerified(tx, { userId, via: "provider", email });
};
