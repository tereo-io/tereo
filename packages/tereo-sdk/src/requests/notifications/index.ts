import { tryHandleRequest } from "../../utils/tryHandleRequest.js";
import { CORE_CLIENT } from "../../handler.js";
import { urlPath } from "../paths.js";
import type {
  Notification,
  SendNotificationInput,
  SendNotificationResult,
} from "../../types/notifications.js";

export const createNotification = async (
  body: SendNotificationInput
): Promise<SendNotificationResult> => {
  const res = await tryHandleRequest<SendNotificationResult>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.notifications.create",
      method: "POST",
      url: "/v1/notifications",
      data: body,
    },
    "NTF_0001",
    "Failed to send notification"
  );
  return res.data;
};

export const getNotification = async (id: string): Promise<Notification> => {
  const res = await tryHandleRequest<Notification>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.notifications.get",
      method: "GET",
      url: urlPath`/v1/notifications/${id}`,
    },
    "NTF_0002",
    `Failed to fetch notification ${id}`
  );
  return res.data;
};
