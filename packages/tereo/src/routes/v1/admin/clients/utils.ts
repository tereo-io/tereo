import { ValidationError } from "../../../../utils/errors.js";
import db from "../../../../utils/db/index.js";

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
