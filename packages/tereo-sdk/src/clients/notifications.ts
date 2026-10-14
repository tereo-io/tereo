import { requests } from "../handler.js";
import { v7 as uuidv7 } from "uuid";
import type {
  Notification,
  SendNotificationInput,
  SendNotificationResult,
} from "../types/notifications.js";

/**
 * Sends notifications through core. Without an `idempotencyKey` one is
 * generated, so the handler's retries of a call send one notification. For
 * at-least-once delivery, write through `core.outbox.notify` instead; its
 * reaper calls `sendAsync` directly.
 */
export class NotificationsClient {
  static noop(): NotificationsClient {
    const client = new NotificationsClient();
    client.sendAsync = async () => ({ id: "noop", status: "pending" });
    client.send = client.sendAsync;
    return client;
  }

  /** Throws on failure; the outbox reaper reads the status off the error to decide a retry. */
  async sendAsync(
    input: SendNotificationInput
  ): Promise<SendNotificationResult> {
    return await requests.notifications.createNotification({
      ...input,
      idempotencyKey: input.idempotencyKey ?? uuidv7(),
    });
  }

  async send(input: SendNotificationInput): Promise<SendNotificationResult> {
    return await this.sendAsync(input);
  }

  async get(id: string): Promise<Notification> {
    return await requests.notifications.getNotification(id);
  }
}
