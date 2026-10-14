import { ValidationError } from "./errors.js";
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
    throw new ValidationError(`Invalid request params. ${message}`);
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
    throw new ValidationError(`Invalid request query. ${message}`);
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
    throw new ValidationError(`Invalid request body. ${message}`);
  }
  return result.data;
};
