import type { z } from "zod";

// Structural, so a schema from another copy of zod still counts.
export const isZodObject = (value: unknown): value is z.ZodObject =>
  typeof value === "object" &&
  value !== null &&
  (value as { _zod?: { def?: { type?: unknown } } })._zod?.def?.type ===
    "object";
