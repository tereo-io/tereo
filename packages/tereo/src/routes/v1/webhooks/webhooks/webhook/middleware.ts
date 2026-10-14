import { validateOrganizationId } from "../../../../../middleware/organizationId.js";
import { guardArchivedById } from "../../../../../utils/guardArchived.js";
import { NotFoundError } from "../../../../../utils/errors.js";
import db from "../../../../../utils/db/index.js";
import type { Request } from "express";

// Ownership is enforced per-controller (not in a preceding middleware), so the
// guard's load must re-check it: fetching by bare id would let the archived 409
// fire before the ownership 404 and leak archive state to out-of-org callers.
// Another organization's endpoint is a 404, as if it did not exist.
const loadOwned = async (id: string, req: Request) => {
  const endpoint = await db.webhookEndpoints.getById(id);
  if (endpoint.organizationId !== validateOrganizationId(req)) {
    throw new NotFoundError("Webhook endpoint not found");
  }
  return endpoint;
};

/** Refuses any change to an archived endpoint (409). */
export const guardArchivedWebhook = guardArchivedById(loadOwned, {
  allow: () => false,
});
