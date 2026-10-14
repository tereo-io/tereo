import { MAX_CLIENT_ID_LENGTH, MAX_TOKEN_LENGTH } from "../utils.js";
import { z } from "zod";

export const IntrospectRequestSchema = z.object({
  token: z.string().min(1).max(MAX_TOKEN_LENGTH),
  // RFC 7009 / 7662: only a hint; an unknown value is ignored.
  token_type_hint: z.string().max(64).optional(),
  client_id: z.string().max(MAX_CLIENT_ID_LENGTH).optional(),
});

export type IntrospectRequest = z.infer<typeof IntrospectRequestSchema>;
