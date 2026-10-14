import type { NotificationRecipient } from "../../api/types";

/** Requested recipients as one line; a user recipient has no address until resolved. */
export const recipientsText = (recipients: NotificationRecipient[]) =>
  recipients.map((r) => r.address ?? `user ${r.userId}`).join(", ");
