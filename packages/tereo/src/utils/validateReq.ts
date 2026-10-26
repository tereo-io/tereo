import { issuesOf, ValidationError } from "./errors.js";
import type { Request } from "express";
import { ZodSchema, z } from "zod";

export const validateParams = <T extends ZodSchema>(
  schema: T,
  req: Request
): z.infer<T> => {
  const result = schema.safeParse(req.params);
  if (!result.success) {
    const message = result.error.issues
      .map((e) => `${e.path.join(".")}: ${e.message}`)
      .join(", ");
    throw new ValidationError(
      `Invalid request params. ${message}`,
      issuesOf(result.error)
    );
  }
  return result.data;
};

export const validateQuery = <T extends ZodSchema>(
  schema: T,
  req: Request
): z.infer<T> => {
  const result = schema.safeParse(req.query);
  if (!result.success) {
    const message = result.error.issues
      .map((e) => `${e.path.join(".")}: ${e.message}`)
      .join(", ");
    throw new ValidationError(
      `Invalid request query. ${message}`,
      issuesOf(result.error)
    );
  }
  return result.data;
};

export const validateBody = <T extends ZodSchema>(
  schema: T,
  req: Request
): z.infer<T> => {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    const message = result.error.issues
      .map((e) => `${e.path.join(".")}: ${e.message}`)
      .join(", ");
    throw new ValidationError(
      `Invalid request body. ${message}`,
      issuesOf(result.error)
    );
  }
  return result.data;
};

/** Header names arrive lowercased: key the schema by `"x-metadata"`, not `"X-Metadata"`. */
export const validateHeaders = <T extends ZodSchema>(
  schema: T,
  req: Request
): z.infer<T> => {
  const result = schema.safeParse(req.headers);
  if (!result.success) {
    const message = result.error.issues
      .map((e) => `${e.path.join(".")}: ${e.message}`)
      .join(", ");
    throw new ValidationError(
      `Invalid request headers. ${message}`,
      issuesOf(result.error)
    );
  }
  return result.data;
};
