import { NotificationsClient } from "./clients/notifications.js";
import type { AuthServiceClientConfig } from "./types/auth.js";
import { assertTestModeAllowed } from "./utils/testTokens.js";
import { WebhookServiceClient } from "./clients/webhooks.js";
import { createHandler, resetHandler } from "./handler.js";
import { AuditLogServiceClient } from "./clients/audit.js";
import { FileServiceClient } from "./clients/files.js";
import type { OutboxOptions } from "./types/outbox.js";
import { AuthServiceClient } from "./clients/auth.js";
import { OutboxClient } from "./clients/outbox.js";
import { useCacheRedis } from "./utils/cache.js";
import type { Redis } from "ioredis";
import {
  closeFileServiceCache,
  startFileServiceCache,
} from "./utils/fileCache.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CoreClientOptions {
  /** This service's slug, as core knows it. Recorded as the source of its audit entries. */
  service: string;
  /** Core's base URL. Default: `CORE_URL`. */
  url?: string;
  /** From Add service. Default: `CORE_CLIENT_ID`. */
  clientId?: string;
  /** From Add service, shown once. Default: `CORE_CLIENT_SECRET`. */
  clientSecret?: string;
  /** Encrypts what the request handler stores; 32+ characters. Default: `REQUEST_HANDLER_KEY`. */
  requestHandlerKey?: string;
  /**
   * The SDK's Redis: the request handler's rate limits and tokens, and the
   * read caches. Needs `maxRetriesPerRequest: null`. The caller owns it.
   */
  redis: Redis;
  /** Default: `NODE_ENV === "production"`. */
  production?: boolean;
  /** Public routes, test-token permissions and introspection caching for `auth`. */
  auth?: AuthServiceClientConfig;
  /**
   * For an app service's tests: `auth` accepts forged `test-token-…` tokens
   * and stubs user and organization lookups, and `files` answers with stubs.
   * Default false. Throws unless `NODE_ENV` is `test` or `development`, and
   * with `production: true`.
   */
  testMode?: boolean;
  /**
   * With `testMode`: the UUID that the test token user `service` resolves to,
   * so tests can match a service user's id. Throws if not a UUID.
   */
  testServiceUserId?: string;
  /**
   * Event types `webhooks.emit` accepts, to reject typos before the request.
   * Without it, any type is accepted and core decides.
   */
  eventTypes?: string[];
  /**
   * The transactional outbox, in the app's own database. Without it,
   * `core.outbox` throws; `audit.log` and `webhooks.emit` remain, best-effort.
   */
  outbox?: OutboxOptions;
  /**
   * Core's `REDIS_KEY_PREFIX`, when it sets one: the file cache listens for
   * core's invalidations on channels under it. Default: none.
   */
  channelPrefix?: string;
}

export interface CoreClient {
  auth: AuthServiceClient;
  files: FileServiceClient;
  webhooks: WebhookServiceClient;
  audit: AuditLogServiceClient;
  /** Send notifications through core, or read one back. Needs the `notification_sender` role. */
  notifications: NotificationsClient;
  /**
   * Write audit entries, webhook events and notifications in your own transaction; they reach
   * core after it commits. Requires the `outbox` option.
   */
  outbox: OutboxClient;
  /** Start the request handler and the file cache. Call once at boot. */
  start(): Promise<void>;
  /** Stop them, the reaper and the caches; the process may then create another client. */
  stop(): Promise<void>;
}

const option = (
  value: string | undefined,
  envName: string,
  what: string
): string => {
  const resolved = value ?? process.env[envName];
  if (!resolved) {
    throw new Error(
      `@tereo-io/sdk: ${what} is required — pass it to createCoreClient or set ${envName}`
    );
  }
  return resolved;
};

/**
 * Everything an app service needs from core, over one set of credentials:
 * `auth`, `files`, `webhooks` and `audit`. One per process.
 *
 * ```ts
 * const core = createCoreClient({ service: "product-service", redis });
 * await core.start();
 * await core.files.uploadObject(...);
 * ```
 */
export const createCoreClient = (options: CoreClientOptions): CoreClient => {
  const testMode = options.testMode ?? false;
  if (testMode) assertTestModeAllowed(options.production);
  if (
    options.testServiceUserId !== undefined &&
    !UUID_RE.test(options.testServiceUserId)
  ) {
    throw new Error("@tereo-io/sdk: testServiceUserId must be a UUID");
  }
  const url = option(options.url, "CORE_URL", "url");
  const clientId = option(options.clientId, "CORE_CLIENT_ID", "clientId");
  const handler = createHandler({
    url,
    clientId,
    clientSecret: option(
      options.clientSecret,
      "CORE_CLIENT_SECRET",
      "clientSecret"
    ),
    requestHandlerKey: option(
      options.requestHandlerKey,
      "REQUEST_HANDLER_KEY",
      "requestHandlerKey"
    ),
    redis: options.redis,
    production: options.production ?? process.env.NODE_ENV === "production",
  });

  useCacheRedis(options.redis, `@tereo-io/sdk:${clientId}`);
  const audit = new AuditLogServiceClient({ source: options.service });
  const webhooks = new WebhookServiceClient({ eventTypes: options.eventTypes });
  const notifications = new NotificationsClient();
  const outbox = options.outbox
    ? new OutboxClient(options.outbox, {
        audit,
        webhooks,
        notifications,
      })
    : null;

  return {
    auth: new AuthServiceClient(
      options.auth,
      testMode,
      options.testServiceUserId
    ),
    files: new FileServiceClient(undefined, testMode),
    webhooks,
    audit,
    notifications,
    get outbox(): OutboxClient {
      if (!outbox) {
        throw new Error(
          "@tereo-io/sdk: pass the `outbox` option to createCoreClient to use core.outbox"
        );
      }
      return outbox;
    },
    start: async () => {
      await handler.start();
      await startFileServiceCache({ channelPrefix: options.channelPrefix });
      await audit.init();
      outbox?.start();
    },
    stop: async () => {
      await outbox?.stop();
      await audit.close();
      await closeFileServiceCache();
      await handler.stop();
      resetHandler();
      useCacheRedis(null);
    },
  };
};
