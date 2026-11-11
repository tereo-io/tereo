import { issuesOf, ValidationError } from "./errors.js";
import type { Request } from "express";
import { ZodSchema, z } from "zod";

type SchemaDef = {
  type: string;
  format?: string;
  innerType?: ZodSchema;
  element?: ZodSchema;
  shape?: Record<string, ZodSchema>;
  options?: ZodSchema[];
};

const WRAPPERS = new Set([
  "optional",
  "nullable",
  "default",
  "prefault",
  "nonoptional",
  "readonly",
  "catch",
]);

/**
 * `value` with every string that `schema` declares as a UUID in lower case.
 * `z.guid()` accepts either case and returns the caller's spelling, while a
 * uuid column and everything read from it is lower case: an id used as a
 * string — a path, a lock or limiter key, a secret's name — has to match.
 */
export const lowerCaseUuids = (schema: ZodSchema, value: unknown): unknown => {
  const def = schema._zod.def as SchemaDef;
  if (def.type === "string") {
    return typeof value === "string" &&
      (def.format === "guid" || def.format === "uuid")
      ? value.toLowerCase()
      : value;
  }
  if (WRAPPERS.has(def.type) && def.innerType) {
    return lowerCaseUuids(def.innerType, value);
  }
  if (def.type === "array" && def.element && Array.isArray(value)) {
    const element = def.element;
    return value.map((item) => lowerCaseUuids(element, item));
  }
  if (
    def.type === "object" &&
    def.shape &&
    value !== null &&
    typeof value === "object"
  ) {
    const out: Record<string, unknown> = { ...value };
    for (const [key, field] of Object.entries(def.shape)) {
      if (key in out) out[key] = lowerCaseUuids(field, out[key]);
    }
    return out;
  }
  if (def.type === "union" && def.options) {
    const option = def.options.find((o) => o.safeParse(value).success);
    return option ? lowerCaseUuids(option, value) : value;
  }
  return value;
};

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
  return lowerCaseUuids(schema, result.data) as z.infer<T>;
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
  return lowerCaseUuids(schema, result.data) as z.infer<T>;
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
  return lowerCaseUuids(schema, result.data) as z.infer<T>;
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
