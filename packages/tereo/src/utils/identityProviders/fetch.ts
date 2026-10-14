import { assertExternalTargetSafe } from "../ssrfGuard.js";
import type { Agent } from "undici";
import env from "../../env.js";

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * `fetch` for requests to an identity provider, whose URLs an admin typed:
 * each host is resolved, refused if private, and connected to through a
 * dispatcher pinned to the checked addresses. `OIDC_ALLOW_PRIVATE_ISSUERS`
 * turns the guard off.
 */
export const guardedFetch: typeof fetch = async (input, init) => {
  if (env.OIDC_ALLOW_PRIVATE_ISSUERS) return fetch(input, init);
  const url = input instanceof Request ? input.url : input.toString();
  const dispatcher = await assertExternalTargetSafe(url);
  try {
    const response = await fetch(input, {
      ...init,
      // A redirect would leave the pinned addresses.
      redirect: "manual",
      dispatcher,
    } as RequestInit & { dispatcher?: Agent });
    // Read in full before the dispatcher, and with it the socket, closes.
    const body = await response.arrayBuffer();
    return new Response(NULL_BODY_STATUSES.has(response.status) ? null : body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } finally {
    await dispatcher.close().catch(() => {});
  }
};
