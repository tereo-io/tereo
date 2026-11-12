import type { TereoMcpOptions, ToolDefinition } from "./types.js";
import { createRateLimiter } from "./rateLimit.js";
import { runStartChecks } from "./startChecks.js";
import { ToolRegistry } from "./registry.js";
import type { Router } from "express";
import pino from "pino";
import {
  createRouter,
  listenOn,
  type Listening,
  type Started,
} from "./http.js";

export interface TereoMcp {
  define<I>(tool: ToolDefinition<I>): void;
  router(): Promise<Router>;
  listen(port: number, host?: string): Promise<Listening>;
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
    }
    return started;
  };

  return {
    define: (tool) => registry.define(tool as ToolDefinition),
    router: async () => createRouter(await start()),
    listen: async (port, host) => listenOn(await start(), port, host),
  };
};
