import { z } from "zod";

export const webhookDeliveryIdParamSchema = z.object({
  id: z.guid(),
  deliveryId: z.guid(),
});
