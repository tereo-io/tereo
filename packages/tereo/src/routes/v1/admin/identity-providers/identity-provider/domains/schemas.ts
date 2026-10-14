import { z } from "zod";

const HOSTNAME =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// `@Acme.COM` is stored as `acme.com`.
export const DomainNameSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/^@/, "").toLowerCase())
  .pipe(z.string().regex(HOSTNAME, "Must be a valid domain name"));

export const CreateDomainSchema = z.object({
  domain: DomainNameSchema,
  organizationId: z.guid(),
  autoAccept: z.boolean().default(false),
  ssoOnly: z.boolean().default(false),
  roleIds: z.array(z.guid()).max(100).default([]),
});

// No defaults: an update changes only what the request sent.
export const UpdateDomainSchema = z.object({
  domain: DomainNameSchema.optional(),
  organizationId: z.guid().optional(),
  autoAccept: z.boolean().optional(),
  ssoOnly: z.boolean().optional(),
  roleIds: z.array(z.guid()).max(100).optional(),
});

export type CreateDomainInput = z.infer<typeof CreateDomainSchema>;
