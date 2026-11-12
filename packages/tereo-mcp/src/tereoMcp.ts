import { checkListenOptions, runStartChecks } from "./startChecks.js";
import { createRateLimiter } from "./rateLimit.js";
import { ToolRegistry } from "./registry.js";
import type { Router } from "express";
import type { z } from "zod";
import pino from "pino";
import type {
  ListenOptions,
  StaticTool,
  TereoMcpOptions,
  ToolDefinition,
} from "./types.js";
import {
  createRouter,
  listenOn,
  type Listening,
  type Started,
} from "./http.js";

export interface TereoMcp {
  define<
    S extends z.ZodObject | undefined = undefined,
    O extends z.ZodObject | undefined = undefined,
  >(
    tool: StaticTool<S, O>
  ): void;
  define<I = unknown, O extends z.ZodObject | undefined = undefined>(
    tool: ToolDefinition<I, O>
  ): void;
  router(): Promise<Router>;
  listen(
    port: number,
    host?: string,
    options?: ListenOptions
  ): Promise<Listening>;
}

const DEFAULT_PER_MINUTE = 120;

export const createTereoMcp = (options: TereoMcpOptions): TereoMcp => {
  const registry = new ToolRegistry();
  const logger = options.logger ?? pino({ name: "@tereo-io/mcp" });
  let started: Promise<Started> | undefined;

  const start = (): Promise<Started> => {
    if (!started) {
      registry.freeze();
      const tools = registry.list();
      started = runStartChecks(options, tools).then((state) => ({
        options,
        tools,
        state,
        logger,
        limiter:
          options.rateLimit === false || !options.redis
            ? null
            : createRateLimiter({
                redis: options.redis,
                service: options.name,
                perMinute: options.rateLimit?.perMinute ?? DEFAULT_PER_MINUTE,
                logger,
              }),
      }));
      // A failed start (core unreachable, say) is retried by the next call.
      started.catch(() => {
        started = undefined;
      });
    }
    return started;
  };

  return {
    // Every overload's definition is a ToolDefinition<never>: no handler input type is narrower.
    define: (tool: ToolDefinition<never>) =>
      registry.define(tool as ToolDefinition),
    router: async () => createRouter(await start()),
    listen: async (port, host, listenOptions) => {
      checkListenOptions(listenOptions);
      return listenOn(await start(), port, host, listenOptions);
    },
  };
};
