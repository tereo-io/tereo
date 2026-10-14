import { MAX_CLIENT_ID_LENGTH, MAX_REDIRECT_URI_LENGTH } from "../utils.js";
import { z } from "zod";
import {
  UNSAFE_REDIRECT_URI_MESSAGE,
  isSafeRedirectUri,
} from "../../../utils/redirectUris.js";

const postLogoutRedirectUri = z
  .string()
  .max(MAX_REDIRECT_URI_LENGTH)
  .url()
  .refine(isSafeRedirectUri, { message: UNSAFE_REDIRECT_URI_MESSAGE })
  .optional();

export const EndSessionRequestSchema = z.object({
  id_token_hint: z.string().max(8192).optional(),
  post_logout_redirect_uri: postLogoutRedirectUri,
  state: z.string().max(512).optional(),
  client_id: z.string().max(MAX_CLIENT_ID_LENGTH).optional(),
});

export const EndSessionConfirmGetSchema = z.object({
  client_id: z.string().min(1).max(MAX_CLIENT_ID_LENGTH),
  confirm_token: z.string().min(1).max(64),
});

export const EndSessionConfirmSchema = EndSessionConfirmGetSchema.extend({
  post_logout_redirect_uri: postLogoutRedirectUri,
  state: z.string().max(512).optional(),
});

export type EndSessionRequest = z.infer<typeof EndSessionRequestSchema>;
