import { z } from "zod";

const slug = z
  .string()
  .min(1)
  .max(50)
  .regex(/^[a-z0-9-]+$/, "slug must be lowercase letters, digits and hyphens");

const channel = z.enum(["email"]);

export const ListConnectionsQuerySchema = z.object({
  channel: channel.optional(),
});

// `settings` and `secrets` are validated by the channel's adapter.
export const CreateConnectionSchema = z.strictObject({
  channel,
  slug,
  displayName: z.string().min(1).max(100),
  settings: z.record(z.string(), z.unknown()),
  secrets: z.record(z.string(), z.unknown()).optional(),
  isEnabled: z.boolean().optional(),
  maxPerMinute: z.number().int().min(1).max(1_000_000).nullable().optional(),
});
