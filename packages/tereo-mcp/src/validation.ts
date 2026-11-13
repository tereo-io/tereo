import type { RequestHandler } from "express";
import {
  hostHeaderValidation as mcpHostHeaderValidation,
  originValidation as mcpOriginValidation,
} from "@modelcontextprotocol/express";

// The return types are spelled out so the emitted declarations name Express
// alone: a type from @modelcontextprotocol/express there would bring its
// req.auth declaration into the importing app.

export const hostHeaderValidation = (
  allowedHosts: readonly string[]
): RequestHandler => mcpHostHeaderValidation([...allowedHosts]);

export const originValidation = (
  allowedOrigins: readonly string[]
): RequestHandler => mcpOriginValidation([...allowedOrigins]);
