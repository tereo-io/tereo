import { logger } from "../../utils/logger.js";
import db from "../../utils/db/index.js";
import type { Server } from "socket.io";
import type {
  PermissionChangePayload,
  ServerToClientEvents,
  ClientToServerEvents,
} from "../types.js";

type IOServer = Server<ClientToServerEvents, ServerToClientEvents>;

let io: IOServer | null = null;

export const setIO = (ioInstance: IOServer) => {
  io = ioInstance;
};

export const getIO = (): IOServer => {
  if (!io) throw new Error("Socket.io not initialized");
  return io;
};

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
