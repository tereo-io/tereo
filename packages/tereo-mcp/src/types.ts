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
  destructive?: boolean;
  idempotent?: boolean;
  /** Overrides `toolTimeoutMs` for this tool. A positive integer. */
  timeoutMs?: number;
}

export interface ToolDefinition<I = unknown> extends ToolFields {
  input?: ToolInput;
  handler: (input: I, ctx: ToolContext) => unknown | Promise<unknown>;
}

type InputOf<S> = S extends z.ZodObject ? z.output<S> : undefined;

/** A definition whose `input`, when present, is a static schema that types the handler's input. */
export type StaticTool<S extends z.ZodObject | undefined> = ToolFields & {
  input?: S;
  handler: (input: InputOf<S>, ctx: ToolContext) => unknown | Promise<unknown>;
};

export type RateLimitRedis = Pick<Redis, "incr" | "expire" | "ttl">;

export interface TereoMcpOptions {
  name: string;
  version: string;
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
