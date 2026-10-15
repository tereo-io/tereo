import { hasPermission } from "../../../../utils/permissions.js";
import { CORE_SERVICE } from "../../../../definitions/index.js";
import type { Prisma } from "../../../../utils/db/prisma.js";
import { validateUser } from "../../../../utils/auth.js";
import db from "../../../../utils/db/index.js";
import {
  ForbiddenError,
  UnprocessableEntityError,
  ValidationError,
} from "../../../../utils/errors.js";

export const verifyScopes = async (requestedScopes: string[]) => {
  if (requestedScopes.length === 0) return;
  const availableScopes = await db.scopes.search(requestedScopes);
  const availableScopeNames = availableScopes.map((s) => s.name);
  const invalidScopes = requestedScopes.filter(
    (s) => !availableScopeNames.includes(s)
  );
  if (!invalidScopes.length) return;
  throw new ValidationError(
    `Invalid scopes: ${invalidScopes.join(
      ", "
    )}. Available scopes must be registered in the database first.`
  );
};

/**
 * The audience as stored: deduplicated and sorted. Each slug must be an
 * existing service other than core, whose audience a token names already
 * whenever core scopes are granted.
 */
export const verifyAudience = async (
  slugs: string[],
  tx?: Prisma.TransactionClient
): Promise<string[]> => {
  const unique = [...new Set(slugs)].sort();
  if (unique.length === 0) return unique;
  const known = await db.services.findSlugs(unique, tx);
  const invalid = unique.filter(
    (s) => s === CORE_SERVICE.slug || !known.has(s)
  );
  if (invalid.length > 0) {
    throw new UnprocessableEntityError(
      "invalid_audience",
      `Not a service that can be named in an audience: ${invalid.join(", ")}`
    );
  }
  return unique;
};

export const assertMayChangeAudience = (
  user: ReturnType<typeof validateUser>
) => {
  if (!hasPermission(user.permissions, "services.approve")) {
    throw new ForbiddenError(
      "Setting a client's audience requires services.approve"
    );
  }
};
