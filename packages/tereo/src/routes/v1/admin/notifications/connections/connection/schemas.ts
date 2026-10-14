import { z } from "zod";

export const ConnectionIdParamSchema = z.object({ id: z.guid() });

/** Omitted keeps a field; `secrets: null` clears the secrets. */
export const UpdateConnectionSchema = z.strictObject({
  displayName: z.string().min(1).max(100).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  secrets: z.record(z.string(), z.unknown()).nullable().optional(),
  isEnabled: z.boolean().optional(),
  maxPerMinute: z.number().int().min(1).max(1_000_000).nullable().optional(),
});

export const TestConnectionSchema = z.object({ to: z.email().max(320) });
