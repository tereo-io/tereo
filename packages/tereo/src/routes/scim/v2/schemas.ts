import { z } from "zod";

export const MAX_COUNT = 200;
const DEFAULT_COUNT = 100;
const MAX_START_INDEX = 1_000_000_000;

const integer = (value: unknown) =>
  typeof value === "string" && /^-?\d+$/.test(value) ? Number(value) : value;

export const scimListQuerySchema = z.object({
  filter: z.string().optional(),
  startIndex: z.preprocess(
    integer,
    z
      .number()
      .int()
      .default(1)
      .transform((n) => Math.min(Math.max(n, 1), MAX_START_INDEX))
  ),
  count: z.preprocess(
    integer,
    z
      .number()
      .int()
      .min(0)
      .default(DEFAULT_COUNT)
      .transform((n) => Math.min(n, MAX_COUNT))
  ),
});
