import { guardArchivedById } from "../../../../../utils/guardArchived.js";
import db from "../../../../../utils/db/index.js";

// Archived roles are read-only: allow GET, hard DELETE, and restore; every
// other method 409s. A missing id makes getAny throw NotFoundError, which the
// guard forwards as the 404. Each route checks its permission first, so a
// caller without it gets 403 whatever the role's state.
export const guardArchivedRole = guardArchivedById((id) => db.roles.getAny(id));

// The role's sub-routes are all mutations of an archived row, whatever the
// method and path; the default whitelist would read a DELETE on a sub-router's
// root as the role's own hard delete.
export const guardArchivedRoleChild = guardArchivedById(
  (id) => db.roles.getAny(id),
  { allow: (req) => req.method === "GET" }
);
