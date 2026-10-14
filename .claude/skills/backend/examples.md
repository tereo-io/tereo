# Backend Code Examples

Condensed from real tereo code: the admin organizations resource (auth area) and webhook
endpoints (an org-scoped resource). Paths are relative to `packages/tereo/`.

## Area Router — `src/routes/v1/admin/index.ts`

`requireAuth` and the rate limiter go on the area router, once.

```typescript
import { rateLimitGeneral } from "../../middleware/rateLimit.js";
import organizationsRouter from "./organizations/index.js";
import permissionsRouter from "./permissions/index.js";
import { requireAuth } from "../../middleware/auth.js";
import settingsRouter from "./settings/index.js";
import servicesRouter from "./services/index.js";
import clientsRouter from "./clients/index.js";
import usersRouter from "./users/index.js";
import rolesRouter from "./roles/index.js";
import { Router } from "express";

const adminRouter = Router();

adminRouter.use(requireAuth);
adminRouter.use(rateLimitGeneral);

adminRouter.use("/clients", clientsRouter);
adminRouter.use("/organizations", organizationsRouter);
adminRouter.use("/permissions", permissionsRouter);
adminRouter.use("/roles", rolesRouter);
adminRouter.use("/services", servicesRouter);
adminRouter.use("/settings", settingsRouter);
adminRouter.use("/users", usersRouter);

export default adminRouter;
```

An area with anonymous reads builds its own `requireAuth` — `src/routes/v1/files/index.ts`:

```typescript
const requireAuth = createRequireAuth({
  publicRoutes: [
    { pattern: PUBLIC_OBJECT_LIST },
    { pattern: PUBLIC_BY_KEY },
    // ...GET/HEAD only by default; each controller still re-checks bucket.policy
  ],
});

router.use(requireAuth);
router.use(rateLimitGeneral);
router.use("/buckets", bucketsRouter);
```

## Resource Router — `src/routes/v1/admin/organizations/index.ts`

```typescript
import { requirePermission } from "../../../middleware/auth.js";
import organizationRouter from "./organization/index.js";
import { Router } from "express";
import {
  createOrganization,
  getDefaultOrganization,
  listOrganizations,
} from "./controllers.js";

const organizationsRouter = Router();

// Specific lookup routes must be registered before the catch-all /:id mount.
organizationsRouter.get(
  "/default",
  requirePermission("organizations.read"),
  getDefaultOrganization
);

organizationsRouter.use("/:id", organizationRouter);

organizationsRouter.get(
  "/",
  requirePermission("organizations.read"),
  listOrganizations
);
organizationsRouter.post(
  "/",
  requirePermission("organizations.write"),
  createOrganization
);

export default organizationsRouter;
```

Files, webhooks and audit use the `PERMISSIONS` constants — `src/routes/v1/webhooks/webhooks/index.ts`:

```typescript
import { resolveWebhookOrganizationId } from "../../../../middleware/organizationId.js";
import { PERMISSIONS } from "../../../../definitions/permissions.js";
import { requirePermission } from "../../../../middleware/auth.js";
import webhookRouter from "./webhook/index.js";
import * as controllers from "./controllers.js";
import { Router } from "express";

const webhooksRouter = Router();

webhooksRouter.use(resolveWebhookOrganizationId);

webhooksRouter.use("/:id", webhookRouter);

webhooksRouter.get(
  "/",
  requirePermission(PERMISSIONS.WEBHOOKS.READ),
  controllers.listWebhookEndpoints
);
webhooksRouter.post(
  "/",
  requirePermission(PERMISSIONS.WEBHOOKS.WRITE),
  controllers.createWebhookEndpoint
);

export default webhooksRouter;
```

## Item Router — `src/routes/v1/admin/organizations/organization/index.ts`

`mergeParams` exposes `:id`. The router file only wires routes; its guards live in the folder's
`middleware.ts`. Static paths before generic `/` routes.

```typescript
import { requirePermission } from "../../../../../middleware/auth.js";
import membersRouter from "./members/index.js";
import { Router } from "express";
import {
  guardArchivedOrganization,
  requireOrgMember,
} from "./middleware.js";
import {
  archiveOrganization,
  getOrganization,
  restoreOrganization,
  updateOrganization,
} from "./controllers.js";

const router = Router({ mergeParams: true });

router.use(requireOrgMember);
router.use(guardArchivedOrganization);

router.use("/members", membersRouter);

// There is no delete: audit entries, buckets and webhooks reference organizations.
router.post(
  "/archive",
  requirePermission("organizations.archive"),
  archiveOrganization
);
router.post(
  "/restore",
  requirePermission("organizations.archive"),
  restoreOrganization
);

router.get("/", getOrganization);
router.patch("/", updateOrganization);

export default router;
```

## Route-Local Middleware — `src/routes/v1/admin/organizations/organization/middleware.ts`

```typescript
// Weakest tier this router serves, checked before the archived guard so
// unauthorized callers can't use 403-vs-409 to probe archive state.
export const requireOrgMember = async (
  req: Request,
  _res: Response,
  next: NextFunction
) => {
  try {
    const params = validateParams(OrgIdParamSchema, req);
    await requireOrgRole("member", req, params.id);
    next();
  } catch (err) {
    next(err);
  }
};

export const guardArchivedOrganization = guardArchivedById((id) =>
  db.organizations.getAny(id)
);
```

## Schemas — `src/routes/v1/admin/organizations/schemas.ts`

```typescript
import { createCursorQuerySchema } from "../../../utils/parseQueryString.js";
import { z } from "zod";

export const CreateOrganizationSchema = z.object({
  name: z.string().min(1).max(255),
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(
      /^[a-z0-9][a-z0-9-]*$/,
      "Slug must start with a letter or number and contain only lowercase letters, numbers, and hyphens"
    ),
  code: z
    .string()
    .min(1)
    .max(6)
    .regex(/^[A-Z0-9]+$/, "Code must be uppercase alphanumeric (A-Z, 0-9)"),
});

export const OrgIdParamSchema = z.object({
  id: z.string().uuid(),
});

const stringToBoolean = z
  .enum(["true", "false"])
  .transform((val) => val === "true");

export const ListOrganizationsQuerySchema = createCursorQuerySchema({
  filters: {
    name: { operators: ["contains", "equals"], schema: z.string() },
    slug: { operators: ["contains", "equals"], schema: z.string() },
    isActive: { operators: ["equals"], schema: stringToBoolean },
  },
  sortFields: {
    id: "id",
    name: "name",
    createdAt: "createdAt",
  },
  defaultSort: "id",
});

export const listOrganizationsExtraQuerySchema = z.object({
  // Strict parse: z.coerce.boolean() would treat "false" as true.
  includeArchived: z
    .enum(["true", "false"])
    .optional()
    .default("false")
    .transform((v) => v === "true"),
});

export type CreateOrganizationInput = z.infer<typeof CreateOrganizationSchema>;
```

## Controllers (Create, List) — `src/routes/v1/admin/organizations/controllers.ts`

```typescript
import { getDefaultOrganizationId } from "../../../utils/defaultOrganization.js";
import { validateBody, validateQuery } from "../../../utils/validateReq.js";
import { formatOrganization } from "../../../utils/transformers.js";
import { emitTx, logAuditTx } from "../../../utils/outbox.js";
import { ConflictError } from "../../../utils/errors.js";
import { validateUser } from "../../../utils/auth.js";
import type { Request, Response } from "express";
import db from "../../../utils/db/index.js";
import {
  applyCursorToWhere,
  buildCursorPageResponse,
} from "../../../utils/cursor.js";
import {
  CreateOrganizationSchema,
  ListOrganizationsQuerySchema,
  listOrganizationsExtraQuerySchema,
} from "./schemas.js";

export const createOrganization = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const body = validateBody(CreateOrganizationSchema, req);

  // The unique index spans archived rows, so the check must see them too.
  const existing = await db.organizations.getBySlugAny(body.slug);
  if (existing) {
    throw new ConflictError("Organization with this slug already exists");
  }

  const org = await db.$transaction(async (tx) => {
    const created = await db.organizations.create(body, tx);
    await logAuditTx(tx, {
      auth,
      organizationId: created.id,
      action: "CREATE",
      entityType: "Organization",
      entityId: created.id,
      entityName: created.name,
      metadata: { slug: created.slug, code: created.code },
    });
    await emitTx(tx, {
      organizationId: getDefaultOrganizationId(),
      eventType: "auth.organization.created",
      entityType: "Organization",
      entityId: created.id,
      data: formatOrganization(created) as Record<string, unknown>,
    });
    return created;
  });

  res.status(201).json(formatOrganization(org));
};

export const listOrganizations = async (req: Request, res: Response) => {
  const query = validateQuery(ListOrganizationsQuerySchema, req);
  const { includeArchived } = validateQuery(
    listOrganizationsExtraQuerySchema,
    req
  );

  const result = await db.organizations.getPaginated({
    take: query.limit,
    orderBy: query.orderBy,
    where: applyCursorToWhere(query),
    includeArchived,
  });

  // { data, hasMore, limit, nextCursor }
  const page = buildCursorPageResponse(result, query);
  res.json({ ...page, data: page.data.map(formatOrganization) });
};
```

## Controllers (Update) — `src/routes/v1/admin/organizations/organization/controllers.ts`

```typescript
import { getDefaultOrganizationId } from "../../../../utils/defaultOrganization.js";
import { validateBody, validateParams } from "../../../../utils/validateReq.js";
import { formatOrganization } from "../../../../utils/transformers.js";
import { requireOrgRole } from "../../../../utils/orgRoleAuth.js";
import { ConflictError } from "../../../../utils/errors.js";
import { validateUser } from "../../../../utils/auth.js";
import { UpdateOrganizationSchema } from "./schemas.js";
import { OrgIdParamSchema } from "../schemas.js";
import type { Request, Response } from "express";
import db from "../../../../utils/db/index.js";
import {
  computeChanges,
  emitTx,
  logAuditTx,
} from "../../../../utils/outbox.js";

export const updateOrganization = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const params = validateParams(OrgIdParamSchema, req);
  await requireOrgRole("owner", req, params.id);
  const body = validateBody(UpdateOrganizationSchema, req);

  const existing = await db.organizations.get(params.id);

  if (body.slug) {
    const conflict = await db.organizations.getBySlugAny(body.slug);
    if (conflict && conflict.id !== params.id) {
      throw new ConflictError("Organization with this slug already exists");
    }
  }

  const org = await db.$transaction(async (tx) => {
    const updated = await db.organizations.update(params.id, body, tx);
    await logAuditTx(tx, {
      auth,
      organizationId: updated.id,
      action: "UPDATE",
      entityType: "Organization",
      entityId: updated.id,
      entityName: updated.name,
      changes: computeChanges(existing, updated),
    });
    await emitTx(tx, {
      organizationId: getDefaultOrganizationId(),
      eventType: "auth.organization.updated",
      entityType: "Organization",
      entityId: updated.id,
      data: formatOrganization(updated) as Record<string, unknown>,
    });
    return updated;
  });

  res.json(formatOrganization(org));
};
```

## Org-Scoped Controller — `src/routes/v1/webhooks/webhooks/webhook/controllers.ts`

The organization comes from the token; ownership is checked after the load.

```typescript
import { validateOrganizationId } from "../../../../../middleware/organizationId.js";
import { rethrowRestrictedAsConflict } from "../../../../../utils/prismaErrors.js";
import { validateParams } from "../../../../../utils/validateReq.js";
import { validateUser } from "../../../../../middleware/auth.js";
import { ForbiddenError } from "../../../../../utils/errors.js";
import { webhookEndpointIdParamSchema } from "./schemas.js";
import { logAuditTx } from "../../../../../utils/outbox.js";
import db from "../../../../../utils/db/index.js";
import { Request, Response } from "express";

export const deleteWebhookEndpoint = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const organizationId = validateOrganizationId(req);
  const { id } = validateParams(webhookEndpointIdParamSchema, req);

  const existing = await db.webhookEndpoints.getById(id);
  if (existing.organizationId !== organizationId) {
    throw new ForbiddenError("Resource does not belong to this client");
  }

  await db.$transaction(async (tx) => {
    try {
      await db.webhookEndpoints.remove(id, tx);
    } catch (err) {
      // Delivery history (ON DELETE RESTRICT) still references this endpoint.
      rethrowRestrictedAsConflict(
        err,
        "Webhook endpoint still has delivery history and cannot be deleted"
      );
      throw err;
    }
    await logAuditTx(tx, {
      auth,
      organizationId,
      action: "DELETE",
      entityType: "WebhookEndpoint",
      entityId: id,
      metadata: { url: existing.url },
    });
  });

  res.status(204).send();
};
```

## Database Layer — `src/utils/db/organizations.ts`

```typescript
import { BadRequestError, ConflictError, NotFoundError } from "../errors.js";
import { Prisma } from "../../../prisma/generated/client/index.js";
import { prisma } from "./prisma.js";

interface GetPaginatedOptions {
  /** Over-fetch happens inside the helper — pass the user's requested page size. */
  take: number;
  orderBy?: Record<string, "asc" | "desc">[];
  where?: Record<string, unknown>;
  /** Include archived rows (default false). Admin listing only. */
  includeArchived?: boolean;
}

/** Operational lookup — archived organizations are invisible here. */
export const get = async (id: string, tx?: Prisma.TransactionClient) => {
  const db = tx ?? prisma;
  const res = await db.organization.findUnique({
    where: { id, archivedAt: null },
    include: { _count: { select: { members: true } } },
  });
  if (!res) throw new NotFoundError("Organization not found");
  return res;
};

export const getPaginated = async (options: GetPaginatedOptions) => {
  const { take, orderBy, where, includeArchived } = options;

  // The archive guard spreads LAST so no caller-supplied filter can override it.
  const whereClause = {
    ...where,
    ...(includeArchived ? {} : { archivedAt: null }),
  };

  // Over-fetch one row to learn whether another page exists.
  const rows = await prisma.organization.findMany({
    take: take + 1,
    orderBy,
    where: whereClause,
    include: { _count: { select: { members: true } } },
  });

  const hasMore = rows.length > take;
  return { data: hasMore ? rows.slice(0, take) : rows, hasMore };
};

export const archive = async (id: string, tx?: Prisma.TransactionClient) => {
  const db = tx ?? prisma;
  const existing = await db.organization.findFirst({
    where: { id, archivedAt: null },
  });
  if (!existing) throw new NotFoundError("Organization not found");
  if (existing.isDefault) {
    throw new BadRequestError(
      "default_organization",
      "The default organization cannot be archived"
    );
  }
  // Re-assert the gate in the WHERE so a concurrent reactivate can't slip
  // through between the read above and this write.
  const result = await db.organization.updateMany({
    where: { id, archivedAt: null, isActive: false, isDefault: false },
    data: { archivedAt: new Date() },
  });
  if (result.count === 0) {
    throw new ConflictError(
      "Organization must be deactivated before it can be archived"
    );
  }
  return await db.organization.findUniqueOrThrow({
    where: { id },
    include: { _count: { select: { members: true } } },
  });
};
```

Register a new file in `src/utils/db/index.ts` (`import * as organizations from "./organizations.js"`,
added to the default export under its area) — `db` is one object across every table, plus
`db.$transaction`.

## Raw SQL — `src/utils/db/buckets.ts`

Every table is schema-qualified.

```typescript
export const decrementUsage = async (
  id: number,
  sizeBytes: bigint,
  tx?: Prisma.TransactionClient
) => {
  const client = tx ?? prisma;
  await client.$executeRaw`
    UPDATE "files"."buckets"
    SET "current_usage_bytes" = GREATEST(0, "current_usage_bytes" - ${sizeBytes}::bigint)
    WHERE "id" = ${id}
  `;
};
```

## Declaring Permissions, Roles, Event Types — `src/definitions/`

Registered by `registerCore()` on every start; never seeded, never created through the API.

```typescript
// permissions.ts — the catalog entry (name, displayName, description)...
export const WEBHOOK_PERMISSIONS: PermissionDefinition[] = [
  adminPermission("webhooks.admin", "Webhooks Administrator", "Full webhook access"),
  ...domainPermissions("webhooks", "Webhooks", "webhooks", [
    "read",
    "write",
    "archive",
    "delete",
  ]),
];
// PERMISSION_CATALOG spreads WEBHOOK_PERMISSIONS, so registerCore() picks it up.

// ...and the constant call sites use with requirePermission()
export const PERMISSIONS = {
  WEBHOOKS: {
    ADMIN: "webhooks.admin",
    READ: "webhooks.read",
    WRITE: "webhooks.write",
    ARCHIVE: "webhooks.archive",
    DELETE: "webhooks.delete",
  },
} as const;

// roles.ts — a system role holding it
{
  name: "webhook_admin",
  displayName: "Webhook Administrator",
  description: "Full access to webhooks",
  permissions: ["webhooks.admin"],
},

// eventTypes.ts — emitTx rejects anything not listed
{ eventType: "auth.organization.created", description: "Organization created" },
```

## Prisma Model — `prisma/schema.prisma`

```prisma
model WebhookEndpoint {
  id             String    @id @default(uuid(7)) @db.Uuid
  organizationId String    @map("organization_id") @db.Uuid
  url            String    @db.VarChar(2048)
  description    String?
  status         WebhookEndpointStatus @default(ACTIVE)
  archivedAt     DateTime? @map("archived_at")
  createdAt      DateTime  @default(now()) @map("created_at")
  updatedAt      DateTime  @updatedAt @map("updated_at")
  createdBy      String    @map("created_by") @db.Uuid

  deliveries    WebhookDelivery[]
  subscriptions WebhookEndpointEventType[]
  // Actor column: a FK into auth.users, never a free-text id.
  creator       User         @relation("WebhookEndpointCreator", fields: [createdBy], references: [id], onDelete: Restrict)
  organization  Organization @relation(fields: [organizationId], references: [id], onDelete: Restrict)

  @@index([organizationId, status])
  @@index([archivedAt])
  @@map("webhook_endpoints")
  @@schema("webhooks")
}
```

## Environment — `src/env.ts` (condensed)

```typescript
import "./preload.js";
import { redisEnvFields, refineRedisEnv } from "./utils/redisEnv.js";
import { cursorSigningEnvFields } from "./utils/cursorSigner.js";
import { z } from "zod";

const bool = (fallback: "true" | "false") =>
  z
    .string()
    .default(fallback)
    .transform((val) => val === "true" || val === "1");

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    ROLE: z.enum(["all", "api", "worker"]).default("all"),
    PORT: z.coerce.number().default(4001),
    PUBLIC_URL: z.string().url().default("http://localhost:4001"),
    DATABASE_URL: z.string(),
    ...redisEnvFields(),
    ...cursorSigningEnvFields("CURSOR"),
    // Generated into core.secrets when unset — see loadKeys().
    JWT_PRIVATE_KEY: z.string().min(32).optional(),
    SINGLE_TENANT: bool("false"),
    REGISTRY_RETIREMENT_GRACE_HOURS: z.coerce.number().min(0).default(24),
    AUDIT_RETENTION_DAYS: z.coerce.number().int().min(1).default(90),
  })
  .superRefine((val, ctx) => refineRedisEnv(val, ctx));

export type Env = z.infer<typeof EnvSchema>;

const env = EnvSchema.parse({
  ...process.env,
  JWT_PRIVATE_KEY: readSecret("JWT_PRIVATE_KEY", true), // base64 PEM in env
});

export default env;
```
