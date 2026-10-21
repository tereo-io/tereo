import { assertExternalTargetSafe } from "../ssrfGuard.js";
import { UpstreamAuthError } from "./errors.js";
import type { Agent } from "undici";
import env from "../../env.js";

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/** Discovery documents, JWKS and token responses are a few KiB. */
export const UPSTREAM_RESPONSE_MAX_BYTES = 1024 * 1024;

const tooLarge = (url: string) =>
  new UpstreamAuthError(
    "upstream_failed",
    `Response from ${new URL(url).origin} exceeds ${UPSTREAM_RESPONSE_MAX_BYTES} bytes`
  );

/** The body, refused past the cap without reading the rest. */
const readCapped = async (
  response: Response,
  url: string
): Promise<Uint8Array> => {
  const declared = Number(response.headers.get("content-length"));
  if (declared > UPSTREAM_RESPONSE_MAX_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw tooLarge(url);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > UPSTREAM_RESPONSE_MAX_BYTES) {
      await reader.cancel().catch(() => {});
      throw tooLarge(url);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
};

const capped = async (response: Response, url: string): Promise<Response> => {
  const body = await readCapped(response, url);
  return new Response(NULL_BODY_STATUSES.has(response.status) ? null : body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

/**
 * `fetch` for requests to an identity provider, whose URLs an admin typed:
 * each host is resolved, refused if private, and connected to through a
 * dispatcher pinned to the checked addresses. `OIDC_ALLOW_PRIVATE_ISSUERS`
 * turns the guard off, but not the cap on the response's size.
 */
export const guardedFetch: typeof fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : input.toString();
  if (env.OIDC_ALLOW_PRIVATE_ISSUERS) {
    return capped(await fetch(input, init), url);
  }
  const dispatcher = await assertExternalTargetSafe(url);
  try {
    const response = await fetch(input, {
      ...init,
      // A redirect would leave the pinned addresses.
      redirect: "manual",
      dispatcher,
    } as RequestInit & { dispatcher?: Agent });
    // Read in full before the dispatcher, and with it the socket, closes.
    return await capped(response, url);
  } finally {
    await dispatcher.close().catch(() => {});
  }
};
