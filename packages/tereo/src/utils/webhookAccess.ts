import { PERMISSIONS } from "../definitions/permissions.js";
import type { WebhookScope } from "./webhookOwnership.js";
import { SYSTEM_USER_ID } from "../definitions/index.js";
import { canReadBucket } from "./bucketAccess.js";
import { hasPermission } from "./permissions.js";
import { prisma } from "./db/prisma.js";
import db from "./db/index.js";
import {
  ForbiddenError,
  ManagedByIntegrationError,
  ManagedByProvisioningError,
  NotFoundError,
} from "./errors.js";

/**
 * A webhook endpoint acts as the user who created it: it is sent an event only
 * while that user is active and could read the event themselves — through
 * `webhooks.read` and the event type's `readPermission` in the event's
 * organization, and for a file event, read access to the bucket it names. An
 * endpoint a service owns acts as the service's account, which needs no
 * `webhooks.read`: its subscriptions come from provisioning, not the API.
 */

/** File events carry their bucket in `data.bucketName`. */
const BUCKET_EVENT_PREFIX = "file-service.";

export interface EventReadRule {
  eventType: string;
  readPermission: string | null;
}

/**
 * 403 unless `permissions` (the caller's, in the endpoint's organization)
 * read every event type in `rules`. A file event's bucket is checked per
 * event, when it is sent.
 */
export const assertMaySubscribe = (
  permissions: string[],
  rules: EventReadRule[]
): void => {
  const unreadable = rules.filter(
    (r) => r.readPermission && !hasPermission(permissions, r.readPermission)
  );
  if (unreadable.length > 0) {
    throw new ForbiddenError(
      `Insufficient permissions to receive: ${unreadable
        .map((r) => `${r.eventType} (needs ${r.readPermission})`)
        .join(", ")}`
    );
  }
};

/**
 * The permissions a user acts with in `organizationId`: their global roles,
 * and that organization's roles while they are a member of it and it is
 * active. Null for an inactive user, who acts with none.
 */
const actingPermissions = async (
  userId: string,
  organizationId: string
): Promise<string[] | null> => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { isActive: true },
  });
  if (!user?.isActive) return null;
  const member = await prisma.organizationMember.findFirst({
    where: {
      userId,
      organizationId,
      organization: { isActive: true, archivedAt: null },
    },
    select: { id: true },
  });
  return db.roles.getUserPermissions(userId, member ? organizationId : null);
};

export interface FanoutEvent {
  organizationId: string;
  eventType: string;
  data: Record<string, unknown>;
}

/** Whether `actor`, acting in the event's organization, could read it. */
const mayReadEvent = async (
  actor: { userId: string; permissions: string[] },
  event: FanoutEvent,
  readPermission: string | null,
  { requireWebhooksRead = true }: { requireWebhooksRead?: boolean } = {}
): Promise<boolean> => {
  const { permissions } = actor;
  if (
    requireWebhooksRead &&
    !hasPermission(permissions, PERMISSIONS.WEBHOOKS.READ)
  )
    return false;
  if (readPermission && !hasPermission(permissions, readPermission)) {
    return false;
  }
  if (!event.eventType.startsWith(BUCKET_EVENT_PREFIX)) return true;
  const { bucketName } = event.data;
  // A file event that names no bucket is read only by whoever reads them all.
  if (typeof bucketName !== "string") {
    return hasPermission(permissions, "file-service.admin");
  }
  return canReadBucket(
    {
      userId: actor.userId,
      permissions,
      organizationId: event.organizationId,
    },
    bucketName
  );
};

export interface RecipientEndpoint {
  createdBy: string;
  ownerServiceId: string | null;
}

/**
 * Whether `endpoint` may be sent `event`. Build one per event: each creator's
 * answer is computed once however many endpoints they made.
 */
export const createRecipientCheck = (
  event: FanoutEvent,
  readPermission: string | null
): ((endpoint: RecipientEndpoint) => Promise<boolean>) => {
  const answers = new Map<string, Promise<boolean>>();

  const decide = async (userId: string, owned: boolean): Promise<boolean> => {
    if (userId === SYSTEM_USER_ID) return true;
    const permissions = await actingPermissions(userId, event.organizationId);
    if (!permissions) return false;
    return mayReadEvent({ userId, permissions }, event, readPermission, {
      requireWebhooksRead: !owned,
    });
  };

  return ({ createdBy, ownerServiceId }) => {
    const owned = ownerServiceId !== null;
    const key = `${createdBy}:${owned}`;
    let answer = answers.get(key);
    if (!answer) {
      answer = decide(createdBy, owned);
      answers.set(key, answer);
    }
    return answer;
  };
};

/**
 * The endpoint, if the caller may see it in `scope`: for an integration, one
 * it owns; otherwise the scope organization's own, or, with `webhooks.admin`,
 * an owned endpoint sent every organization's events. An endpoint an
 * integration owns is seen by anyone else only with `webhooks.admin`: it is
 * sent what the integration may read, so whoever could redirect it could read
 * that too. Any other is a 404, as if it did not exist.
 */
export const getVisibleEndpoint = async (
  id: string,
  viewer: { permissions: string[] },
  { organizationId, owner }: WebhookScope
) => {
  const endpoint = await db.webhookEndpoints.getById(id);
  const isAdmin = hasPermission(viewer.permissions, PERMISSIONS.WEBHOOKS.ADMIN);
  const visible = owner
    ? endpoint.ownerServiceId === owner.id
    : endpoint.ownerService?.kind === "integration" && !isAdmin
      ? false
      : endpoint.organizationId === null
        ? isAdmin
        : endpoint.organizationId === organizationId;
  if (!visible) throw new NotFoundError("Webhook endpoint not found");
  return endpoint;
};

/**
 * 409 `managed_by_integration` unless the caller is the integration that owns
 * `endpoint`, if one does. Anyone else (an admin, see `getVisibleEndpoint`)
 * may only pause, archive, restore or delete it.
 */
export const assertNotManagedByIntegration = (
  endpoint: {
    ownerServiceId: string | null;
    ownerService: { kind: string } | null;
  },
  { owner }: WebhookScope
): void => {
  if (endpoint.ownerService?.kind !== "integration") return;
  if (owner?.id === endpoint.ownerServiceId) return;
  throw new ManagedByIntegrationError();
};

/** 409 `managed_by_provisioning`: a provisioned endpoint changes only through its file. */
export const assertNotProvisioned = (endpoint: {
  provisioned: boolean;
}): void => {
  if (endpoint.provisioned) throw new ManagedByProvisioningError();
};

interface StoredDelivery {
  eventType: string;
  payload: unknown;
  responseBody: string | null;
}

/**
 * `deliveries` as `viewer` may see them: the payload, and the receiver's
 * response that may echo it, only when the viewer could read the event
 * (`viewer.permissions` are those of their request, in the scope's
 * organization). An all-organization endpoint carries other organizations'
 * events: each is judged by what the viewer may read in the event's own
 * organization. An integration reading its own needs no `webhooks.read`, as
 * when they are sent.
 */
export const redactUnreadable = async <T extends StoredDelivery>(
  viewer: { userId: string; permissions: string[] },
  { organizationId, owner }: WebhookScope,
  deliveries: T[]
): Promise<(T & { payloadRedacted: boolean })[]> => {
  const readPermissions = await db.eventTypes.readPermissions(
    deliveries.map((d) => d.eventType)
  );
  const permissionsIn = new Map<string, Promise<string[]>>();
  if (organizationId) {
    permissionsIn.set(organizationId, Promise.resolve(viewer.permissions));
  }
  const permissionsOf = (org: string) => {
    let permissions = permissionsIn.get(org);
    if (!permissions) {
      permissions = actingPermissions(viewer.userId, org).then((p) => p ?? []);
      permissionsIn.set(org, permissions);
    }
    return permissions;
  };
  return Promise.all(
    deliveries.map(async (delivery) => {
      const payload = delivery.payload as {
        data?: unknown;
        organizationId?: unknown;
      } | null;
      const data =
        payload?.data && typeof payload.data === "object"
          ? (payload.data as Record<string, unknown>)
          : {};
      // A test send names no organization; it is the request's, and a
      // platform integration's has none: core's own test payload, read with
      // the integration's global permissions.
      const eventOrg =
        typeof payload?.organizationId === "string"
          ? payload.organizationId
          : organizationId;
      const readPermission = readPermissions.get(delivery.eventType) ?? null;
      const readable =
        eventOrg === null
          ? !readPermission || hasPermission(viewer.permissions, readPermission)
          : await mayReadEvent(
              {
                userId: viewer.userId,
                permissions: await permissionsOf(eventOrg),
              },
              { organizationId: eventOrg, eventType: delivery.eventType, data },
              readPermission,
              { requireWebhooksRead: !owner }
            );
      return readable
        ? { ...delivery, payloadRedacted: false }
        : {
            ...delivery,
            payload: null,
            responseBody: null,
            payloadRedacted: true,
          };
    })
  );
};
