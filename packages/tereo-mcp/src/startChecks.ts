import type { OAuthMetadata } from "@modelcontextprotocol/server";
import type { TereoMcpOptions, ToolDefinition } from "./types.js";

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
  checkPositiveInteger("maxResultBytes", options.maxResultBytes);
  checkAllowedOrigins(options.allowedOrigins);
  checkPermissions(options, tools);

  const coreUrl = options.coreUrl ?? process.env.CORE_URL;
  if (!coreUrl) fail("coreUrl is not set and neither is CORE_URL");

  const oauthMetadata = await fetchMetadata(coreUrl, fetchImpl);
  checkIssuer(oauthMetadata.issuer);
  return { resourceUrl: `${origin}${path}`, oauthMetadata };
};
