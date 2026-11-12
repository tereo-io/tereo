import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type { StartState } from "./startChecks.js";
import { requestScope } from "./requestScope.js";
import { createVerifier } from "./verifier.js";
import type { ServerDeps } from "./server.js";
import { buildServer } from "./server.js";
import { randomUUID } from "node:crypto";
import type { Router } from "express";
import express from "express";
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthMetadataRouter,
  requireBearerAuth,
} from "@modelcontextprotocol/express";

export interface Started extends ServerDeps {
  state: StartState;
}

export const createRouter = (started: Started): Router => {
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
  const handler = toNodeHandler(
    createMcpHandler((ctx) => buildServer(started, ctx.authInfo), {
      onerror: (err) => logger.warn({ err }, "MCP request failed"),
    })
  );

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
  return router;
};
