import type { NextFunction, Request, Response, Router } from "express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type { AddressInfo, Socket } from "node:net";
import type { StartState } from "./startChecks.js";
import { requestScope } from "./requestScope.js";
import { originHostname } from "./validation.js";
import type { ListenOptions } from "./types.js";
import { createVerifier } from "./verifier.js";
import type { ServerDeps } from "./server.js";
import { buildServer } from "./server.js";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import express from "express";
import {
  createMcpExpressApp,
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthMetadataRouter,
  requireBearerAuth,
} from "@modelcontextprotocol/express";
import {
  createMcpHandler,
  isJsonContentType,
} from "@modelcontextprotocol/server";

export interface Started extends ServerDeps {
  state: StartState;
}

export interface McpRoute {
  router: Router;
  close(): Promise<void>;
}

// Read from a clone, so the handler can still read the body itself and answer
// a bad one as it would have.
const parsedBodyOf = async (request: globalThis.Request): Promise<unknown> => {
  try {
    const text = await request.clone().text();
    return text.length === 0 ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
};

const methodsOf = (body: unknown): string[] =>
  (Array.isArray(body) ? body : [body]).flatMap((message: unknown) => {
    const method = (message as { method?: unknown } | null)?.method;
    return typeof method === "string" ? [method] : [];
  });

export const createRouter = (started: Started): Router =>
  createRoute(started).router;

export const createRoute = (
  started: Started,
  closing?: AbortSignal
): McpRoute => {
  const { options, logger, state } = started;
  const resourceUrl = new URL(state.resourceUrl);
  const path = options.path ?? "/mcp";

  const verifier = createVerifier({
    core: options.core,
    allowedClients: options.allowedClients,
    allowServiceAccounts: options.allowServiceAccounts ?? false,
    resourceUrl: state.resourceUrl,
    logger,
  });
  const mcpHandler = createMcpHandler(
    (ctx) => buildServer({ ...started, closing }, ctx.authInfo),
    { onerror: (err) => logger.warn({ err }, "MCP request failed") }
  );
  // Records the request's JSON-RPC methods for buildServer, which the
  // handler's factory is not told. A body the host did not parse is read here
  // (toNodeHandler has already capped its size) and passed on parsed. Only an
  // instructions function reads the methods, so only then is the body read.
  const needsMethods = typeof options.instructions === "function";
  const handler = toNodeHandler({
    fetch: async (request, requestOptions) => {
      if (!needsMethods) return mcpHandler.fetch(request, requestOptions);
      let parsedBody = requestOptions?.parsedBody;
      if (
        parsedBody === undefined &&
        request.method.toUpperCase() === "POST" &&
        isJsonContentType(request.headers.get("content-type"))
      ) {
        parsedBody = await parsedBodyOf(request);
      }
      const scope = requestScope.getStore();
      if (scope) scope.methods = methodsOf(parsedBody);
      return mcpHandler.fetch(request, {
        ...requestOptions,
        ...(parsedBody !== undefined && { parsedBody }),
      });
    },
  });

  const router = express.Router();
  router.all(path, (_req, _res, next) =>
    requestScope.run({ requestId: randomUUID() }, next)
  );
  router.use(
    mcpAuthMetadataRouter({
      oauthMetadata: state.oauthMetadata,
      resourceServerUrl: resourceUrl,
      scopesSupported: options.scopes?.length ? options.scopes : undefined,
    })
  );
  // With no body parser ahead of this router req.body is undefined and the
  // handler reads the request stream itself; a host's express.json() is reused.
  router.all(
    path,
    requireBearerAuth({
      verifier,
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl),
      expectedResource: resourceUrl,
    }),
    (req, res) => void handler(req, res, req.body)
  );
  return { router, close: () => mcpHandler.close() };
};

export interface Listening {
  port: number;
  url: string;
  close(): Promise<void>;
}

const LOOPBACK = ["127.0.0.1", "localhost", "::1"];
const DEFAULT_SIGNALS: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 25_000;

export const listenOn = async (
  started: Started,
  port: number,
  host = "0.0.0.0",
  listenOptions: ListenOptions = {}
): Promise<Listening> => {
  const { options, logger } = started;
  const loopback = LOOPBACK.includes(host);
  const loopbackNames = loopback ? ["localhost", "127.0.0.1", "[::1]"] : [];
  const allowedHosts = [new URL(options.publicUrl).hostname, ...loopbackNames];
  // The SDK compares the Origin's hostname, and a list given here replaces
  // its loopback default rather than adding to it.
  const allowedOrigins = options.allowedOrigins && [
    ...options.allowedOrigins.map(originHostname),
    ...loopbackNames,
  ];
  const app = createMcpExpressApp({ host, allowedHosts, allowedOrigins });
  const beginClose = new AbortController();
  const route = createRoute(started, beginClose.signal);
  app.use(route.router);

  const outer = express();
  // Probes send the pod address as Host, so health sits ahead of host validation.
  outer.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });
  outer.use(app);
  // Without this Express answers a bad body with an HTML page that, outside
  // production, carries the stack and file paths.
  outer.use(
    (err: unknown, _req: Request, res: Response, next: NextFunction) => {
      if (res.headersSent) return next(err);
      const status = (err as { status?: unknown } | null)?.status;
      if (typeof status === "number" && status >= 400 && status < 500) {
        logger.warn({ status }, "MCP request rejected");
        res.status(status).json({ error: "invalid_request" });
        return;
      }
      logger.error({ err }, "MCP request failed");
      res.status(500).json({ error: "server_error" });
    }
  );

  const server = createServer(outer);
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  // closeIdleConnections leaves a connection that has never sent a request
  // open, and clients keep such spare connections pooled for seconds. One
  // that has sent no bytes carries no call, so it is safe to drop.
  const closeIdle = () => {
    server.closeIdleConnections();
    for (const socket of sockets) {
      if (socket.bytesRead === 0) socket.destroy();
    }
  };
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.on("error", (err) => logger.error({ err }, "MCP server error"));
  const bound = (server.address() as AddressInfo).port;
  const urlHost =
    host === "0.0.0.0" || host === "::"
      ? "127.0.0.1"
      : host.includes(":")
        ? `[${host}]`
        : host;

  const timeoutMs =
    listenOptions.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  // A signal listed twice would run onSignal twice and take the forced-exit branch.
  const signals = new Set(
    listenOptions.signals === false
      ? []
      : (listenOptions.signals ?? DEFAULT_SIGNALS)
  );
  let shuttingDown = false;
  let drainTimedOut = false;

  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      // On the signal path the listeners stay until exit, to catch a second signal.
      if (!shuttingDown) removeSignalListeners();
      beginClose.abort(
        new DOMException("The MCP server is closing", "AbortError")
      );
      // Connections that go idle after their last response must not hold close() open.
      const sweep = setInterval(closeIdle, 50);
      let deadline: NodeJS.Timeout | undefined;
      try {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          closeIdle();
          deadline = setTimeout(() => {
            drainTimedOut = true;
            logger.warn(
              { timeout_ms: timeoutMs },
              "MCP server dropped requests still running at the shutdown deadline"
            );
            server.closeAllConnections();
          }, timeoutMs);
        });
      } finally {
        clearInterval(sweep);
        clearTimeout(deadline);
      }
      await route.close();
    })());

  const runOnShutdown = async (): Promise<boolean> => {
    const onShutdown = listenOptions.onShutdown;
    if (!onShutdown) return true;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      const settled = await Promise.race([
        Promise.resolve()
          .then(onShutdown)
          .then(() => true as const),
        timedOut,
      ]);
      if (!settled) {
        logger.error(
          { timeout_ms: timeoutMs },
          "MCP server shutdown timed out"
        );
      }
      return settled;
    } catch (err) {
      logger.error({ err }, "MCP server shutdown failed");
      return false;
    } finally {
      clearTimeout(timer);
    }
  };

  const shutDown = async (signal: NodeJS.Signals) => {
    logger.info({ signal }, "MCP server shutting down");
    let ok = true;
    try {
      await close();
      if (drainTimedOut) ok = false;
    } catch (err) {
      logger.error({ err }, "MCP server shutdown failed");
      ok = false;
    }
    if (!(await runOnShutdown())) ok = false;
    process.exit(ok ? 0 : 1);
  };

  const onSignal = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      logger.warn({ signal }, "MCP server forced to exit");
      process.exit(1);
      return;
    }
    shuttingDown = true;
    void shutDown(signal);
  };
  const removeSignalListeners = () => {
    for (const signal of signals) process.off(signal, onSignal);
  };
  for (const signal of signals) process.on(signal, onSignal);

  return {
    port: bound,
    url: `http://${urlHost}:${bound}${options.path ?? "/mcp"}`,
    close,
  };
};
