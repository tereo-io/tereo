import { z } from "zod";

// Postgres stores neither a NUL in text nor a \u0000 escape in jsonb, and its
// timestamps and JS dates overlap only within the years 1-9999: input outside
// either fails the insert or query with a 500 instead of a 400.

const NUL_MESSAGE = "must not contain a NUL character";

/** True if `value`, or any string, key or element inside it, holds a NUL. */
export const hasNul = (value: unknown): boolean => {
  if (typeof value === "string") return value.includes("\0");
  if (Array.isArray(value)) return value.some(hasNul);
  if (value && typeof value === "object") {
    return Object.entries(value).some(([k, v]) => hasNul(k) || hasNul(v));
  }
  return false;
};

/** A string Postgres can store and compare. */
export const pgText = () =>
  z.string().refine((val) => !val.includes("\0"), NUL_MESSAGE);

/** `schema`, refusing a NUL anywhere in the value — for jsonb columns. */
export const pgJson = <T extends z.ZodType>(schema: T) =>
  schema.refine((val) => !hasNul(val), NUL_MESSAGE);

/** A date Postgres can compare against a timestamp column. */
export const pgDate = () =>
  z.coerce
    .date()
    .refine(
      (d) => d.getUTCFullYear() >= 1 && d.getUTCFullYear() <= 9999,
      "must be a date between the years 1 and 9999"
    );
