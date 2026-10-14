import { createCursorSigner } from "./cursorSigner.js";
import { getRequestPath } from "./requestId.js";
import env from "../env.js";

/**
 * Signs the opaque cursors every list endpoint hands out. One key for the
 * whole service (`CURSOR_SIGNING_KEY_V{n}`), deliberately distinct from the
 * OAuth2 JWT keys — those are RSA for asymmetric token signing; this is a
 * symmetric HMAC for cursor MAC tags. A cursor is bound to the request path
 * of the list that minted it.
 */
export const {
  decodeListCursor,
  encodeListCursor,
  applyCursorToWhere,
  buildCursorPageResponse,
} = createCursorSigner({ env, prefix: "CURSOR", listScope: getRequestPath });

export { buildCursorWhere, mergeCursorWhere } from "./parseQueryString.js";
