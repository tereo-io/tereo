import { MAX_REDIRECT_URI_LENGTH } from "./utils.js";
import { z } from "zod";
import {
  UNSAFE_REDIRECT_URI_MESSAGE,
  isSafeRedirectUri,
} from "../../utils/redirectUris.js";

export const redirectUriSchema = z
  .string()
  .min(1)
  .max(MAX_REDIRECT_URI_LENGTH)
  .url()
  .refine(
    (uri) => {
      try {
        const url = new URL(uri);
        return url.hash === "";
      } catch {
        return false;
      }
    },
    { message: "Redirect URI must not contain a fragment component" }
  )
  .refine(isSafeRedirectUri, { message: UNSAFE_REDIRECT_URI_MESSAGE });
