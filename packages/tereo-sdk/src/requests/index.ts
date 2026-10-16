import * as notifications from "./notifications/index.js";
import * as webhooks from "./webhooks/index.js";
import * as audit from "./audit/index.js";
import * as files from "./files/index.js";
import * as auth from "./auth/index.js";

/** Every request to core, by area — the same areas as core's URLs. */
export default { auth, files, webhooks, audit, notifications };
