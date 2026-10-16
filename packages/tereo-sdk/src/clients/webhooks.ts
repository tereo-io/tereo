import { logger } from "../utils/logger.js";
import { requests } from "../handler.js";
import { v7 as uuidv7 } from "uuid";
import type {
  EmitBatchResult,
  EmitEventParams,
  EmitEventResult,
  WebhookServiceClientConfig,
} from "../types/webhooks.js";

const withKey = (event: EmitEventParams): EmitEventParams => ({
  ...event,
  idempotencyKey: event.idempotencyKey ?? uuidv7(),
});

/** An event type the service did not declare; resending the event cannot help. */
export class UnknownEventTypeError extends Error {
  constructor(
    public readonly eventType: string,
    registered: string[]
  ) {
    super(
      `Unknown event type "${eventType}". Registered types: ${registered.join(", ")}`
    );
    this.name = "UnknownEventTypeError";
  }
}

/**
 * Emits webhook events to core. Event types are declared in the service's
 * provisioning document, not here; `eventTypes` only lets the client
 * reject a typo before the request is made.
 */
export class WebhookServiceClient {
  private validEventTypes: Set<string>;

  constructor(config: WebhookServiceClientConfig = {}) {
    this.validEventTypes = new Set(config.eventTypes ?? []);
  }

  /** Replace the event types `emit` accepts; with none, every type is accepted and core decides. */
  useEventTypes(eventTypes: string[]): void {
    this.validEventTypes = new Set(eventTypes);
  }

  static noop(): WebhookServiceClient {
    const client = new WebhookServiceClient();
    client.emit = () => {};
    client.emitAsync = async () => ({ deliveriesCreated: 0 });
    client.emitBatch = () => {};
    client.emitBatchAsync = async () => ({ results: [] });
    client.assertEventType = () => {};
    return client;
  }

  /**
   * Throws if `eventType` is not one this client was told about. Public so an
   * outbox can validate at publish time — typos surface at the request
   * boundary instead of failing dispatch before dead-lettering. No-op when the
   * client was given no event types.
   */
  assertEventType(eventType: string): void {
    this.validateEventType(eventType);
  }

  private validateEventType(eventType: string): void {
    if (this.validEventTypes.size > 0 && !this.validEventTypes.has(eventType)) {
      throw new UnknownEventTypeError(eventType, [...this.validEventTypes]);
    }
  }

  /**
   * Best-effort fire-and-forget event emission — calls `emitAsync` and
   * swallows any failure. For at-least-once delivery, publish through the
   * outbox (`core.outbox`) instead; its reaper calls `emitAsync` directly.
   */
  emit(event: EmitEventParams): void {
    try {
      this.validateEventType(event.eventType);
    } catch (err) {
      logger.error(
        {
          eventType: event.eventType,
          err,
        },
        "Invalid webhook event type"
      );
      return;
    }

    this.emitAsync(event).catch((err) => {
      logger.error(
        {
          eventType: event.eventType,
          entityId: event.entityId,
          err,
        },
        "Failed to emit webhook event"
      );
    });
  }

  /**
   * Direct synchronous event emission via HTTP POST through request-handler.
   * Validates the event type and throws on failure. Without an
   * `idempotencyKey`, one is generated, so the handler's retries of this call
   * emit one event.
   */
  async emitAsync(event: EmitEventParams): Promise<EmitEventResult> {
    this.validateEventType(event.eventType);
    return await requests.webhooks.emitEvent(withKey(event));
  }

  /**
   * Best-effort batch event emission — calls `emitBatchAsync` and swallows
   * any failure. For at-least-once delivery, publish through the
   * outbox (`core.outbox`) instead.
   */
  emitBatch(events: EmitEventParams[]): void {
    const valid: EmitEventParams[] = [];
    for (const event of events) {
      try {
        this.validateEventType(event.eventType);
        valid.push(event);
      } catch (err) {
        logger.error(
          {
            eventType: event.eventType,
            err,
          },
          "Invalid webhook event type in batch"
        );
      }
    }

    if (valid.length === 0) return;

    this.emitBatchAsync(valid).catch((err) => {
      logger.error(
        {
          count: valid.length,
          err,
        },
        "Failed to emit webhook event batch"
      );
    });
  }

  /**
   * Direct synchronous batch event emission. Validates all event types and
   * throws on failure.
   */
  async emitBatchAsync(events: EmitEventParams[]): Promise<EmitBatchResult> {
    for (const event of events) {
      this.validateEventType(event.eventType);
    }
    return await requests.webhooks.emitBatch({ events: events.map(withKey) });
  }
}
