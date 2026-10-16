import { getVisibleEndpoint } from "../../../../../utils/webhookAccess.js";
import { guardArchivedById } from "../../../../../utils/guardArchived.js";
import { webhookScope } from "../../../../../utils/webhookOwnership.js";
import { validateUser } from "../../../../../middleware/auth.js";
import type { Request } from "express";

// Ownership is enforced per-controller (not in a preceding middleware), so the
// guard's load must re-check it: fetching by bare id would let the archived 409
// fire before the ownership 404 and leak archive state to out-of-org callers.
// An endpoint the caller may not see is a 404, as if it did not exist.
const loadOwned = (id: string, req: Request) =>
  getVisibleEndpoint(id, validateUser(req), webhookScope(req));

/** Refuses any change to an archived endpoint (409). */
export const guardArchivedWebhook = guardArchivedById(loadOwned, {
  allow: () => false,
});
