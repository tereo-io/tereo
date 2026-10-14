import { notificationInputSchema } from "../../../utils/notifications/accept.js";
import { pgText } from "../../../utils/pgInput.js";

// `content` and the recipients' options are checked by the channel's adapter
// when the send is accepted.
export const SendNotificationSchema = notificationInputSchema.extend({
  idempotencyKey: pgText().min(1).max(255).optional(),
});
