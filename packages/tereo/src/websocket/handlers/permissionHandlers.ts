import type { AuthenticatedSocket } from "../types.js";
import { logger } from "../../utils/logger.js";

const permissionHandlers = (socket: AuthenticatedSocket) => {
  const userId = socket.data.userId;

  const handlePing = () => {
    socket.emit("auth:pong", { timestamp: Date.now() });
  };

  socket.on("auth:ping", handlePing);

  socket.on("disconnect", (reason) => {
    logger.debug(
      {
        reason,
      },
      `User ${userId} disconnected from auth WebSocket`
    );
  });
};

export default permissionHandlers;
