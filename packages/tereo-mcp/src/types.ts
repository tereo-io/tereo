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
}

export type ToolInput =
  z.ZodObject | ((ctx: ToolContext) => z.ZodObject | Promise<z.ZodObject>);

export interface ToolDefinition<I = unknown> {
  name: string;
  description: string;
  permission: string | null;
  readOnly: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  input?: ToolInput;
  handler: (input: I, ctx: ToolContext) => unknown | Promise<unknown>;
}

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
