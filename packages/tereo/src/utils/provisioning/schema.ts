import { SEMVER_PATTERN } from "../semver.js";
import { z } from "zod";
import {
  NAMESPACE_PATTERN,
  bucketItem,
  eventTypeItem,
  permissionItem,
  systemRoleItem,
} from "../registry.js";

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Lengths are the columns' (slug, namespace and client_id 64, name 100).
const Slug = z
  .string()
  .max(64)
  .regex(NAMESPACE_PATTERN, "must be lowercase words joined by hyphens");
const EnvName = z
  .string()
  .regex(ENV_NAME_PATTERN, "must be an environment variable name");
const Text = z.string().min(1, "must not be empty");
const Name = Text.max(100);
const ClientId = Text.max(64);

const Description = z.string().max(500);

const ClientEntry = z
  .object({
    clientId: ClientId,
    name: Name,
    clientType: z.enum(["public", "confidential"]).default("public"),
    secretFrom: EnvName.optional(),
    redirectUris: z.array(Text).default([]),
    postLogoutRedirectUris: z.array(Text).default([]),
    scopes: z.array(Text).default([]),
    grantTypes: z
      .array(z.enum(["authorization_code", "refresh_token"]))
      .default(["authorization_code", "refresh_token"]),
    audience: z.array(Text).default([]),
    consentRequired: z.boolean().default(true),
    // Checked by load: core scopes in `scopes`, never the admin ones.
    trustedCoreScopes: z.array(Text).default([]),
    description: Description.optional(),
  })
  .strict();

const WebhookEntry = z
  .object({
    key: Slug,
    url: z.string().max(2048),
    events: z.array(Text).min(1),
    secretFrom: EnvName,
    organizations: z
      .union([z.literal("all"), z.array(z.guid()).min(1)])
      .default("all"),
    description: Description.optional(),
  })
  .strict();

const ServiceEntry = z
  .object({
    slug: Slug,
    name: Name,
    namespace: Slug.optional(),
    clientId: ClientId.optional(),
    // Checked and normalized by load (parseInternalHost).
    internalHost: z.string().max(253).optional(),
    secretFrom: EnvName,
    access: z
      .object({
        roles: z.array(Text).default([]),
        audiences: z.array(Text).default([]),
      })
      .strict()
      .default({ roles: [], audiences: [] }),
    permissions: z.array(permissionItem.strict()).max(1000).default([]),
    systemRoles: z.array(systemRoleItem.strict()).max(200).default([]),
    buckets: z.array(bucketItem.strict()).max(100).default([]),
    eventTypes: z.array(eventTypeItem.strict()).max(1000).default([]),
    webhooks: z.array(WebhookEntry).default([]),
  })
  .strict();

const IntegrationEntry = z
  .object({
    slug: Slug,
    name: Name,
    // Org-bound when set: its tokens carry this org_id. Fixed once created.
    organizationId: z.guid().optional(),
    secretFrom: EnvName,
    // Role names: org-assignable custom roles of the set when org-bound;
    // otherwise also core's roles and `<slug>/<name>` services' system roles.
    roles: z.array(Text).default([]),
    // Slugs of services in the set that may introspect its tokens.
    audiences: z.array(Text).default([]),
  })
  .strict();

const CustomRoleEntry = z
  .object({
    name: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z][a-z0-9_-]*$/, "lowercase letters, digits, _ -"),
    displayName: z.string().min(1).max(255),
    description: Description.optional(),
    orgAssignable: z.boolean().default(false),
    requires2fa: z.boolean().default(false),
    permissions: z.array(z.string().min(1).max(200)),
  })
  .strict();

export const ProvisioningDocumentSchema = z
  .object({
    $schema: z.string().optional(),
    version: z
      .string()
      .max(64)
      .regex(
        SEMVER_PATTERN,
        "a semver version: MAJOR.MINOR.PATCH[-prerelease]"
      ),
    service: ServiceEntry.optional(),
    clients: z.array(ClientEntry).optional(),
    roles: z.array(CustomRoleEntry).optional(),
    integrations: z.array(IntegrationEntry).optional(),
  })
  .strict()
  .refine(
    (d) =>
      d.service ||
      d.clients?.length ||
      d.roles?.length ||
      d.integrations?.length,
    { message: "needs one of service, clients, roles, integrations, not empty" }
  );

export type ProvisioningDocument = z.input<typeof ProvisioningDocumentSchema>;
export type CustomRoleEntry = z.output<typeof CustomRoleEntry>;
