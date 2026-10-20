import { getRedisEmitter } from "./redisEmitter.js";
import { logger } from "../../utils/logger.js";
import db from "../../utils/db/index.js";
import type { Server } from "socket.io";
import type {
  BucketAccessChangePayload,
  PermissionChangePayload,
  ServerToClientEvents,
  ClientToServerEvents,
} from "../types.js";

type IOServer = Server<ClientToServerEvents, ServerToClientEvents>;

let io: IOServer | null = null;

export const setIO = (ioInstance: IOServer) => {
  io = ioInstance;
};

/**
 * The server, or in a process that never started one (the CLI) an emitter
 * with the same `to`/`in`/`emit`/`disconnectSockets` over Redis.
 */
export const getIO = (): IOServer =>
  io ?? (getRedisEmitter() as unknown as IOServer);

export const emitPermissionChangeToUser = (
  userId: string,
  payload: PermissionChangePayload
) => {
  const ioInstance = getIO();
  ioInstance.to(`user:${userId}`).emit("auth:permissions:changed", payload);
  logger.debug(
    {
      payload,
    },
    `Emitted permission change to user ${userId}`
  );
};

export const emitPermissionChangeToUsers = (
  userIds: string[],
  payload: PermissionChangePayload
) => {
  const ioInstance = getIO();
  for (const userId of userIds) {
    ioInstance.to(`user:${userId}`).emit("auth:permissions:changed", payload);
  }
  logger.debug(
    {
      payload,
      userIds,
    },
    `Emitted permission change to ${userIds.length} users`
  );
};

export const notifyUserRolesChanged = (userId: string) => {
  emitPermissionChangeToUser(userId, {
    reason: "user_roles_changed",
    timestamp: Date.now(),
  });
};

export const notifyRolePermissionsChanged = async (roleId: string) => {
  const affectedUserIds = await db.roles.getUserIdsByRoleId(roleId);
  if (affectedUserIds.length === 0) {
    logger.debug(`No users affected by role ${roleId} permission change`);
    return;
  }

  emitPermissionChangeToUsers(
    affectedUserIds.map((u) => u.userId),
    { reason: "role_permissions_changed", timestamp: Date.now() }
  );
};

export const notifyRoleStatusChanged = async (roleId: string) => {
  const affectedUserIds = await db.roles.getUserIdsByRoleId(roleId);
  if (affectedUserIds.length === 0) {
    logger.debug(`No users affected by role ${roleId} status change`);
    return;
  }

  emitPermissionChangeToUsers(
    affectedUserIds.map((u) => u.userId),
    { reason: "role_status_changed", timestamp: Date.now() }
  );
};

export const notifyRoleDeleted = (affectedUserIds: string[]) => {
  if (affectedUserIds.length === 0) {
    logger.debug("No users affected by role deletion");
    return;
  }

  emitPermissionChangeToUsers(affectedUserIds, {
    reason: "role_deleted",
    timestamp: Date.now(),
  });
};

/**
 * A grant on the bucket was given, revoked, or its owner changed. Grants are
 * not in the token, so unlike a role change this asks for no token refresh.
 */
export const notifyBucketAccessChanged = (
  userIds: string[],
  bucketName: string
) => {
  if (userIds.length === 0) return;
  const ioInstance = getIO();
  const payload: BucketAccessChangePayload = {
    bucketName,
    timestamp: Date.now(),
  };
  for (const userId of new Set(userIds)) {
    ioInstance
      .to(`user:${userId}`)
      .emit("files:bucket-access:changed", payload);
  }
  logger.debug(
    { bucketName, userIds },
    `Emitted bucket access change to ${userIds.length} users`
  );
};
