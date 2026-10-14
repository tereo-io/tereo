import { PERMISSIONS } from "../definitions/permissions.js";
import { SYSTEM_USER_ID } from "../definitions/index.js";
import { canReadBucket } from "./bucketAccess.js";
import { hasPermission } from "./permissions.js";
import { ForbiddenError } from "./errors.js";
import { prisma } from "./db/prisma.js";
import db from "./db/index.js";

/**
 * A webhook endpoint acts as the user who created it: it is sent an event only
 * while that user is active and could read the event themselves — through
 * `webhooks.read` and the event type's `readPermission` in the endpoint's
 * organization, and for a file event, read access to the bucket it names.
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
  readPermission: string | null
): Promise<boolean> => {
  const { permissions } = actor;
  if (!hasPermission(permissions, PERMISSIONS.WEBHOOKS.READ)) return false;
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

/**
 * Whether an endpoint created by `createdBy` may be sent `event`. Build one per
 * event: each creator's answer is computed once however many endpoints they
 * made.
 */
export const createRecipientCheck = (
  event: FanoutEvent,
  readPermission: string | null
): ((createdBy: string) => Promise<boolean>) => {
  const answers = new Map<string, Promise<boolean>>();

  const decide = async (userId: string): Promise<boolean> => {
    if (userId === SYSTEM_USER_ID) return true;
    const permissions = await actingPermissions(userId, event.organizationId);
    if (!permissions) return false;
    return mayReadEvent({ userId, permissions }, event, readPermission);
  };

  return (createdBy) => {
    let answer = answers.get(createdBy);
    if (!answer) {
      answer = decide(createdBy);
      answers.set(createdBy, answer);
    }
    return answer;
  };
};

interface StoredDelivery {
  eventType: string;
  payload: unknown;
  responseBody: string | null;
}

/**
 * `deliveries` as `viewer` may see them: the payload, and the receiver's
 * response that may echo it, only when the viewer could read the event
 * (`viewer.permissions` are those of their request, in `organizationId`).
 */
export const redactUnreadable = async <T extends StoredDelivery>(
  viewer: { userId: string; permissions: string[] },
  organizationId: string,
  deliveries: T[]
): Promise<(T & { payloadRedacted: boolean })[]> => {
  const readPermissions = await db.eventTypes.readPermissions(
    deliveries.map((d) => d.eventType)
  );
  return Promise.all(
    deliveries.map(async (delivery) => {
      const payload = delivery.payload as { data?: unknown } | null;
      const data =
        payload?.data && typeof payload.data === "object"
          ? (payload.data as Record<string, unknown>)
          : {};
      const readable = await mayReadEvent(
        viewer,
        { organizationId, eventType: delivery.eventType, data },
        readPermissions.get(delivery.eventType) ?? null
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
