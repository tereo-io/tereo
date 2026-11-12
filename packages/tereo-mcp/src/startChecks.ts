import type { OAuthMetadata } from "@modelcontextprotocol/server";
import type {
  ListenOptions,
  TereoMcpOptions,
  ToolDefinition,
} from "./types.js";

export interface StartState {
  resourceUrl: string;
  oauthMetadata: OAuthMetadata;
}

const isLoopback = (hostname: string): boolean =>
  hostname === "localhost" ||
  hostname === "[::1]" ||
  /^127(\.\d{1,3}){3}$/.test(hostname);

function fail(message: string): never {
  throw new Error(`@tereo-io/mcp cannot start: ${message}`);
}

const checkPublicUrl = (publicUrl: string): string => {
  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch {
    return fail(`publicUrl ${JSON.stringify(publicUrl)} is not a valid URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    fail(`publicUrl ${JSON.stringify(publicUrl)} must be http or https`);
  }
  if (url.pathname.replace(/\/+$/, "") !== "") {
    fail(
      `publicUrl ${JSON.stringify(publicUrl)} must have no path; set the MCP path with the path option`
    );
  }
  if (url.search !== "" || url.hash !== "") {
    fail(
      `publicUrl ${JSON.stringify(publicUrl)} must have no query or fragment`
    );
  }
  if (url.protocol === "http:" && !isLoopback(url.hostname)) {
    fail(
      `publicUrl ${JSON.stringify(publicUrl)} must be https unless its host is loopback`
    );
  }
  return url.origin;
};

const checkPermissions = (
  options: TereoMcpOptions,
  tools: readonly ToolDefinition[]
): void => {
  if (!options.provisioning) return;
  const declared = new Set(
    (options.provisioning.service?.permissions ?? []).map((p) => p.name)
  );
  for (const tool of tools) {
    if (tool.permission !== null && !declared.has(tool.permission)) {
      fail(
        `tool "${tool.name}" needs permission "${tool.permission}", which the provisioning document's service does not declare`
      );
    }
  }
};

const checkPositiveInteger = (name: string, value: number | undefined) => {
  if (value !== undefined && !(Number.isInteger(value) && value > 0)) {
    fail(`${name} must be a positive integer, not ${String(value)}`);
  }
};

export const checkListenOptions = (options: ListenOptions = {}): void => {
  checkPositiveInteger("shutdownTimeoutMs", options.shutdownTimeoutMs);
  const { signals } = options;
  if (signals === undefined || signals === false) return;
  if (!Array.isArray(signals)) {
    fail("signals must be an array of signal names or false");
  }
  for (const signal of signals) {
    if (typeof signal !== "string" || (signal as string) === "") {
      fail(
        `signals entry ${JSON.stringify(signal)} must be a non-empty string`
      );
    }
  }
};

const checkAllowedOrigins = (origins: readonly string[] | undefined) => {
  for (const origin of origins ?? []) {
    let url: URL | undefined;
    try {
      url = new URL(origin);
    } catch {
      url = undefined;
    }
    if (
      !url ||
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.username !== "" ||
      url.password !== ""
    ) {
      fail(
        `allowedOrigins entry ${JSON.stringify(origin)} is not an origin such as "https://app.example.com"`
      );
    }
  }
};

// RFC 6749 section 3.3 scope-token: printable ASCII except space, `"` and `\`.
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

const checkScopes = (scopes: readonly string[] | undefined) => {
  const seen = new Set<string>();
  for (const scope of scopes ?? []) {
    const shown = JSON.stringify(scope);
    if (!SCOPE_TOKEN.test(scope)) {
      fail(
        `scopes entry ${shown} must be a non-empty string of printable characters with no whitespace, quote or backslash`
      );
    }
    if (scope === "offline_access") {
      fail(
        `scopes entry "offline_access" must not be advertised by a resource server`
      );
    }
    if (seen.has(scope)) fail(`scopes entry ${shown} appears more than once`);
    seen.add(scope);
  }
};

// Mirrors the MCP SDK's own issuer check in mcpAuthMetadataRouter, which
// would otherwise throw from router() or listen() with no context.
const checkIssuer = (issuer: string): void => {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    return fail(`core's issuer ${JSON.stringify(issuer)} is not a valid URL`);
  }
  const insecureAllowed = ["true", "1"].includes(
    process.env.MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL ?? ""
  );
  if (
    url.protocol !== "https:" &&
    url.hostname !== "localhost" &&
    url.hostname !== "127.0.0.1" &&
    !insecureAllowed
  ) {
    fail(
      `core's issuer ${JSON.stringify(issuer)} must be https unless its host is localhost or 127.0.0.1`
    );
  }
  if (url.search !== "" || url.hash !== "") {
    fail(
      `core's issuer ${JSON.stringify(issuer)} must have no query or fragment`
    );
  }
};

const isMetadata = (value: unknown): value is OAuthMetadata => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const doc = value as Record<string, unknown>;
  return (
    typeof doc.issuer === "string" &&
    typeof doc.authorization_endpoint === "string" &&
    typeof doc.token_endpoint === "string"
  );
};

const fetchMetadata = async (
  coreUrl: string,
  fetchImpl: typeof fetch
): Promise<OAuthMetadata> => {
  const url = `${coreUrl.replace(/\/+$/, "")}/.well-known/oauth-authorization-server`;
  let res: Response;
  try {
    res = await fetchImpl(url);
  } catch (err) {
    return fail(
      `fetching ${url} failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!res.ok) return fail(`fetching ${url} answered ${res.status}`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return fail(`${url} did not answer JSON`);
  }
  if (!isMetadata(body)) {
    return fail(
      `${url} did not answer authorization server metadata (issuer, authorization_endpoint, token_endpoint)`
    );
  }
  return body;
};

export const runStartChecks = async (
  options: TereoMcpOptions,
  tools: readonly ToolDefinition[],
  fetchImpl: typeof fetch = fetch
): Promise<StartState> => {
  const origin = checkPublicUrl(options.publicUrl);
  const path = options.path ?? "/mcp";
  if (!path.startsWith("/")) {
    fail(`path ${JSON.stringify(path)} must start with "/"`);
  }
  if (options.allowedClients.length === 0) {
    fail("allowedClients must name at least one OAuth client");
  }
  if (options.rateLimit !== false && !options.redis) {
    fail("redis is required unless rateLimit is false");
  }
  if (options.rateLimit) {
    checkPositiveInteger("rateLimit.perMinute", options.rateLimit.perMinute);
  }
  const ownLimit = tools.find((tool) => tool.rateLimit);
  if (ownLimit && !options.redis) {
    fail(`redis is required: tool "${ownLimit.name}" sets its own rateLimit`);
  }
  checkPositiveInteger("maxResultBytes", options.maxResultBytes);
  checkPositiveInteger("toolTimeoutMs", options.toolTimeoutMs);
  if (
    options.instructions !== undefined &&
    (typeof options.instructions !== "string" ||
      options.instructions.trim() === "")
  ) {
    fail("instructions, when given, must be a non-empty string");
  }
  checkAllowedOrigins(options.allowedOrigins);
  checkScopes(options.scopes);
  checkPermissions(options, tools);

  const coreUrl = options.coreUrl ?? process.env.CORE_URL;
  if (!coreUrl) fail("coreUrl is not set and neither is CORE_URL");

  const oauthMetadata = await fetchMetadata(coreUrl, fetchImpl);
  checkIssuer(oauthMetadata.issuer);
  return { resourceUrl: `${origin}${path}`, oauthMetadata };
};
