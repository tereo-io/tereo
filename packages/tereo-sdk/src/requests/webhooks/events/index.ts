import { tryHandleRequest } from "../../../utils/tryHandleRequest.js";
import { CORE_CLIENT } from "../../../handler.js";
import type {
  EmitBatchInput,
  EmitBatchResult,
  EmitEventParams,
  EmitEventResult,
} from "../types.js";

export const emitEvent = async (
  body: EmitEventParams
): Promise<EmitEventResult> => {
  const res = await tryHandleRequest<EmitEventResult>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.webhooks.emitEvent",
      method: "POST",
      url: "/v1/webhooks/events",
      data: body,
    },
    "WHS_0002",
    "Failed to emit webhook event"
  );
  return res.data;
};

export const emitBatch = async (
  body: EmitBatchInput
): Promise<EmitBatchResult> => {
  const res = await tryHandleRequest<EmitBatchResult>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.webhooks.emitBatch",
      method: "POST",
      url: "/v1/webhooks/events/batch",
      data: body,
    },
    "WHS_0003",
    "Failed to emit webhook event batch"
  );
  return res.data;
};
