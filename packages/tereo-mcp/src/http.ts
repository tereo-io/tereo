import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type { StartState } from "./startChecks.js";
import { requestScope } from "./requestScope.js";
import { createVerifier } from "./verifier.js";
import type { ServerDeps } from "./server.js";
import type { AddressInfo } from "node:net";
import { buildServer } from "./server.js";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Router } from "express";
import express from "express";
import {
  createMcpExpressApp,
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthMetadataRouter,
  requireBearerAuth,
} from "@modelcontextprotocol/express";

export interface Started extends ServerDeps {
  state: StartState;
}

export interface McpRoute {
  router: Router;
  close(): Promise<void>;
}

export const createRouter = (started: Started): Router =>
  createRoute(started).router;

export const createRoute = (started: Started): McpRoute => {
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
    (ctx) => buildServer(started, ctx.authInfo),
    { onerror: (err) => logger.warn({ err }, "MCP request failed") }
  );
  const handler = toNodeHandler(mcpHandler);

  const router = express.Router();
  router.all(path, (_req, _res, next) =>
    requestScope.run({ requestId: randomUUID() }, next)
  );
  router.use(
    mcpAuthMetadataRouter({
      oauthMetadata: state.oauthMetadata,
      resourceServerUrl: resourceUrl,
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

export const listenOn = async (
  started: Started,
  port: number,
  host = "0.0.0.0"
): Promise<Listening> => {
  const { options, logger } = started;
  const loopback = LOOPBACK.includes(host);
  const allowedHosts = [
    new URL(options.publicUrl).hostname,
    ...(loopback ? ["localhost", "127.0.0.1", "[::1]"] : []),
  ];
  const app = createMcpExpressApp({
    host,
    allowedHosts,
    allowedOrigins: options.allowedOrigins,
  });
  const route = createRoute(started);
  app.use(route.router);

  const outer = express();
  // Probes send the pod address as Host, so health sits ahead of host validation.
  outer.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });
  outer.use(app);

  const server = createServer(outer);
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

  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      // Connections that go idle after their last response must not hold close() open.
      const sweep = setInterval(() => server.closeIdleConnections(), 50);
      try {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeIdleConnections();
        });
      } finally {
        clearInterval(sweep);
      }
      await route.close();
    })());

  return {
    port: bound,
    url: `http://${urlHost}:${bound}${options.path ?? "/mcp"}`,
    close,
  };
};
