import { internalServiceRequestInterceptor } from "./internalServiceInterceptor.js";
import RequestHandler, { buildClientName } from "@dianemo/core";
import type { CoreCredentials } from "./types.js";
import type {
  CreateClientData,
  ErrorClassifier,
} from "@dianemo/core/client/types";

export const CORE_TEMPLATE = "tereo";

/** The name of the core client's sub-client that never repeats a write. */
export const ONCE_SUB_CLIENT = "once";

declare module "@dianemo/core" {
  interface ClientTemplates {
    tereo: CoreCredentials;
  }
}

// Generous: core rate-limits callers itself; this only smooths bursts.
const RATE_LIMIT: CreateClientData["rateLimit"] = [
  { type: "requestLimit", interval: 1000, tokensToAdd: 1000, maxTokens: 1000 },
];

// A 4xx from core is the caller's to handle — a 404 the SDK turns into `null`,
// a 409 the outbox waits out — so the handler logs it at debug. 429 stays at
// error: the service is over a limit.
const MUTED_STATUSES = Array.from({ length: 100 }, (_, i) => 400 + i).filter(
  (status) => status !== 429
);

/**
 * For creates core cannot dedupe. After a 5xx or a dropped connection core may
 * already have written, so the caller gets the failure rather than a second
 * create. A 4xx, 429 included, means core refused the request, and the usual
 * rules apply.
 */
export const failUnlessRefused: ErrorClassifier = (error) =>
  !error.response || error.response.status >= 500
    ? { action: "fail" }
    : undefined;

/**
 * The one client for all of core: the service's own client credentials,
 * exchanged at `${baseUrl}/oauth/token`. Its `:once` sub-client shares the
 * token and never retries a request core may have acted on. A second,
 * `:public` client sends the same credentials as Basic auth, for the
 * endpoints that authenticate the client itself rather than a token
 * (introspection).
 */
export async function registerCoreTemplate(handler: RequestHandler) {
  await handler.registerClientTemplate(
    CORE_TEMPLATE,
    (creds): CreateClientData[] => {
      const name = buildClientName(CORE_TEMPLATE, creds);
      const requestOptions = {
        defaults: { baseURL: creds.baseUrl },
        requestInterceptor: internalServiceRequestInterceptor,
      };
      return [
        {
          name,
          rateLimit: RATE_LIMIT,
          requestOptions,
          httpStatusCodesToMute: MUTED_STATUSES,
          // Declares no authentication, so it uses the parent's token.
          subClients: [
            {
              name: ONCE_SUB_CLIENT,
              retryOptions: { classifyError: failUnlessRefused },
            },
          ],
          authentication: {
            type: "oauth2",
            clientId: creds.clientId,
            clientSecret: creds.clientSecret,
            refreshConfig: {
              url: `${creds.baseUrl}/oauth/token`,
              dataLocation: "urlEncodedForm",
              useBasicAuth: true,
              data: {
                grant_type: "client_credentials",
                client_id: creds.clientId,
              },
            },
          },
        },
        {
          name: `${name}:public`,
          rateLimit: RATE_LIMIT,
          requestOptions,
          httpStatusCodesToMute: MUTED_STATUSES,
          authentication: {
            type: "basic",
            username: creds.clientId,
            password: creds.clientSecret,
          },
        },
      ];
    }
  );
}
