import type { Redis } from "ioredis";
import type { Logger } from "pino";
import type { z } from "zod";
import type {
  AuthContext,
  CoreClient,
  ProvisioningDocument,
} from "@tereo-io/sdk";

export interface ToolContext {
  auth: AuthContext;
  core: CoreClient;
  requestId: string;
  logger: Logger;
  /**
   * Aborts when the tool's timeout expires, when the client disconnects or
   * cancels the call, and when a `listen` server begins closing. Pass it to
   * database and HTTP calls: a timeout cannot stop a handler that ignores it.
   */
  signal: AbortSignal;
}

export type ToolInput =
  z.ZodObject | ((ctx: ToolContext) => z.ZodObject | Promise<z.ZodObject>);

interface ToolFields {
  name: string;
  description: string;
  permission: string | null;
  readOnly: boolean;
  /** Display name for people; `name` stays what the model calls. */
  title?: string;
  destructive?: boolean;
  idempotent?: boolean;
  /** Overrides `toolTimeoutMs` for this tool. A positive integer. */
  timeoutMs?: number;
  /**
   * `{ perMinute }`: this tool's own per-user counter, apart from the
   * server-wide one. `false`: not limited. Unset: the server-wide limit.
   */
  rateLimit?: { perMinute: number } | false;
}

// With an output schema the handler returns what the schema parses: its input type.
type ResultOf<O> = [O] extends [z.ZodObject]
  ? z.input<O> | Promise<z.input<O>>
  : unknown;

export interface ToolDefinition<
  I = unknown,
  O extends z.ZodObject | undefined = undefined,
> extends ToolFields {
  input?: ToolInput;
  /** Static only. A successful result is sent as structuredContent and as JSON text. */
  output?: [O] extends [undefined] ? z.ZodObject : O;
  handler: (input: I, ctx: ToolContext) => ResultOf<O>;
}

type InputOf<S> = S extends z.ZodObject ? z.output<S> : undefined;

/** A definition whose `input`, when present, is a static schema that types the handler's input. */
export type StaticTool<
  S extends z.ZodObject | undefined,
  O extends z.ZodObject | undefined = undefined,
> = ToolFields & {
  input?: S;
  output?: O;
  handler: (input: InputOf<S>, ctx: ToolContext) => ResultOf<O>;
};

export type RateLimitRedis = Pick<Redis, "incr" | "expire" | "ttl">;

export interface TereoMcpOptions {
  name: string;
  version: string;
  /** Sent to clients at initialize: how to use this server's tools. */
  instructions?: string;
  core: CoreClient;
  publicUrl: string;
  allowedClients: string[];
  path?: string;
  redis?: RateLimitRedis;
  rateLimit?: { perMinute: number } | false;
  allowServiceAccounts?: boolean;
  allowedOrigins?: string[];
  /**
   * OAuth scopes advertised to MCP clients in the protected-resource
   * metadata, so they request them at sign-in. Advertised only: a token
   * without them is still accepted.
   */
  scopes?: string[];
  provisioning?: ProvisioningDocument;
  logger?: Logger;
  maxResultBytes?: number;
  /** How long a tool call may run before it ends as a timeout. Default 60_000 ms. */
  toolTimeoutMs?: number;
  /** For the metadata fetch at start. Default: `core.url`, else `CORE_URL`. */
  coreUrl?: string;
}

export interface ListenOptions {
  /** Signals that shut the server down. Default ["SIGTERM", "SIGINT"]. `false`: the host handles signals itself. */
  signals?: NodeJS.Signals[] | false;
  /** How long close() waits for in-flight requests before dropping their connections. Default 25_000 ms. */
  shutdownTimeoutMs?: number;
  /** Runs after the server has closed, before the process exits: stop the core client, close Redis. */
  onShutdown?: () => void | Promise<void>;
}
