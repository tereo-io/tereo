import type { ErrorRequestHandler, RequestHandler } from "express";
import { setScimContext } from "../../../utils/scim/context.js";
import { UnauthorizedError } from "../../../utils/errors.js";
import { toScimError } from "../../../utils/scim/errors.js";
import { hashToken } from "../../../utils/scim/tokens.js";
import { redactUrl } from "../../../telemetry/redact.js";
import { logger } from "../../../utils/logger.js";
import db from "../../../utils/db/index.js";

export { scimContext } from "../../../utils/scim/context.js";

const unauthorized = () =>
  new UnauthorizedError("Invalid or missing SCIM token", "unauthorized", {
    headers: { "WWW-Authenticate": "Bearer" },
  });

export const requireScimToken: RequestHandler = async (req, _res, next) => {
  try {
    const match = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? "");
    if (!match) throw unauthorized();

    const token = await db.scim.findLiveToken(hashToken(match[1]));
    if (!token || !token.connection.isActive) throw unauthorized();
    const { provider, ...connection } = token.connection;
    if (!provider.isActive) throw unauthorized();

    setScimContext(req, { connection, provider, tokenId: token.id });
    db.scim.touchConnection(connection.id, token.id).catch((err) => {
      logger.error({ err }, "Failed to record SCIM token use");
    });
    next();
  } catch (err) {
    next(err);
  }
};

// Last on the /scim router, so nothing under it reaches core's JSON error
// handler or the admin UI.
export const scimErrorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const { status, body } = toScimError(err);
  if (status >= 500) {
    logger.error(
      { method: req.method, path: redactUrl(req.originalUrl), status, err },
      err instanceof Error ? err.message : "SCIM request failed"
    );
  } else {
    logger.warn(
      { method: req.method, path: redactUrl(req.originalUrl), status },
      body.detail
    );
  }
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  for (const [name, value] of Object.entries(
    (err as { headers?: Record<string, string | number> }).headers ?? {}
  )) {
    res.setHeader(name, value);
  }
  res.status(status).type("application/scim+json").send(JSON.stringify(body));
};
