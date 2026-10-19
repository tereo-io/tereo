import type { AuthContext } from "../middleware/auth.js";
import db from "./db/index.js";

/** The app service (not an integration) whose service account is calling, or null. */
export const callerService = async (
  auth: Pick<AuthContext, "oauthClientId">
) => {
  if (!auth.oauthClientId) return null;
  const service = await db.services.getByClientId(auth.oauthClientId);
  return service?.kind === "service" ? service : null;
};
