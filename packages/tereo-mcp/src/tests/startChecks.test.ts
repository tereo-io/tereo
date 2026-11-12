import type { TereoMcpOptions, ToolDefinition } from "../types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProvisioningDocument } from "@tereo-io/sdk";
import { runStartChecks } from "../startChecks.js";
import { fakeRedis } from "./support/fakeRedis.js";
import { fakeCore } from "./support/fakeCore.js";

const metadata = {
  issuer: "https://tereo.example.test",
  authorization_endpoint: "https://tereo.example.test/oauth/authorize",
  token_endpoint: "https://tereo.example.test/oauth/token",
  response_types_supported: ["code"],
};

const answering = (status: number, body: unknown) =>
  vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      })
  );

const options = (extra: Partial<TereoMcpOptions> = {}): TereoMcpOptions => ({
  name: "quotes",
  version: "1.0.0",
  core: fakeCore(),
  publicUrl: "https://mcp.example.com",
  allowedClients: ["claude"],
  redis: fakeRedis(),
  coreUrl: "https://tereo.example.test",
  ...extra,
});

const tool = (permission: string | null): ToolDefinition => ({
  name: `tool_${(permission ?? "open").replace(/\./g, "_")}`,
  description: "d",
  permission,
  readOnly: true,
  handler: () => "ok",
});

const provisioning = (...names: string[]): ProvisioningDocument => ({
  version: "1.0.0",
  service: {
    slug: "quotes",
    name: "Quotes",
    secretFrom: "QUOTES_SECRET",
    permissions: names.map((name) => ({ name, displayName: name })),
  },
});

const failure = async (p: Promise<unknown>): Promise<string> => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(Error);
  return (err as Error).message;
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runStartChecks", () => {
  it("joins the public URL and the path into the resource URL", async () => {
    const state = await runStartChecks(
      options({ publicUrl: "https://mcp.example.com/" }),
      [],
      answering(200, metadata)
    );
    expect(state.resourceUrl).toBe("https://mcp.example.com/mcp");
    expect(state.oauthMetadata).toEqual(metadata);
  });

  it("uses a custom path", async () => {
    const state = await runStartChecks(
      options({ path: "/tools/mcp" }),
      [],
      answering(200, metadata)
    );
    expect(state.resourceUrl).toBe("https://mcp.example.com/tools/mcp");
  });

  it("refuses a path that does not start with a slash", async () => {
    const message = await failure(
      runStartChecks(options({ path: "mcp" }), [], answering(200, metadata))
    );
    expect(message).toContain("path");
  });

  it("refuses a publicUrl that does not parse", async () => {
    const message = await failure(
      runStartChecks(
        options({ publicUrl: "not a url" }),
        [],
        answering(200, metadata)
      )
    );
    expect(message).toContain("publicUrl");
  });

  it.each([
    "https://mcp.example.com/base",
    "https://mcp.example.com/base/",
    "https://mcp.example.com/?x=1",
    "https://mcp.example.com/#frag",
    "ftp://mcp.example.com",
  ])("refuses publicUrl %s", async (publicUrl) => {
    const message = await failure(
      runStartChecks(options({ publicUrl }), [], answering(200, metadata))
    );
    expect(message).toContain("publicUrl");
  });

  it("refuses plain http outside loopback", async () => {
    const message = await failure(
      runStartChecks(
        options({ publicUrl: "http://mcp.example.com" }),
        [],
        answering(200, metadata)
      )
    );
    expect(message).toContain("publicUrl");
  });

  it.each([
    ["http://localhost:4002", "http://localhost:4002/mcp"],
    ["http://127.0.0.1:4002/", "http://127.0.0.1:4002/mcp"],
    ["http://[::1]:4002", "http://[::1]:4002/mcp"],
  ])("allows plain http on loopback (%s)", async (publicUrl, resourceUrl) => {
    const state = await runStartChecks(
      options({ publicUrl }),
      [],
      answering(200, metadata)
    );
    expect(state.resourceUrl).toBe(resourceUrl);
  });

  it("refuses an empty allowedClients", async () => {
    const message = await failure(
      runStartChecks(
        options({ allowedClients: [] }),
        [],
        answering(200, metadata)
      )
    );
    expect(message).toContain("allowedClients");
  });

  it("needs redis unless rate limiting is off", async () => {
    const message = await failure(
      runStartChecks(
        options({ redis: undefined }),
        [],
        answering(200, metadata)
      )
    );
    expect(message).toContain("redis");
    await runStartChecks(
      options({ redis: undefined, rateLimit: false }),
      [],
      answering(200, metadata)
    );
  });

  it("refuses a tool permission the provisioning document does not declare", async () => {
    const message = await failure(
      runStartChecks(
        options({ provisioning: provisioning("q.items.read") }),
        [tool(null), tool("q.items.read"), tool("q.items.delete")],
        answering(200, metadata)
      )
    );
    expect(message).toContain("tool_q_items_delete");
    expect(message).toContain("q.items.delete");
  });

  it("accepts tools whose permissions are all declared", async () => {
    await runStartChecks(
      options({ provisioning: provisioning("q.items.read", "q.items.delete") }),
      [tool(null), tool("q.items.read"), tool("q.items.delete")],
      answering(200, metadata)
    );
  });

  it("fetches the authorization server metadata from coreUrl", async () => {
    const fetchImpl = answering(200, metadata);
    await runStartChecks(
      options({ coreUrl: "https://core.internal:4001/" }),
      [],
      fetchImpl
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      "https://core.internal:4001/.well-known/oauth-authorization-server"
    );
  });

  it("falls back to CORE_URL", async () => {
    vi.stubEnv("CORE_URL", "http://core:4001");
    const fetchImpl = answering(200, metadata);
    await runStartChecks(options({ coreUrl: undefined }), [], fetchImpl);
    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      "http://core:4001/.well-known/oauth-authorization-server"
    );
  });

  it("fails when neither coreUrl nor CORE_URL is set", async () => {
    vi.stubEnv("CORE_URL", undefined);
    const fetchImpl = answering(200, metadata);
    const message = await failure(
      runStartChecks(options({ coreUrl: undefined }), [], fetchImpl)
    );
    expect(message).toContain("coreUrl");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails when the metadata fetch answers 500", async () => {
    const message = await failure(
      runStartChecks(options(), [], answering(500, { error: "boom" }))
    );
    expect(message).toContain(
      "https://tereo.example.test/.well-known/oauth-authorization-server"
    );
    expect(message).toContain("500");
  });

  it("fails when the metadata fetch throws", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError("fetch failed");
    });
    const message = await failure(runStartChecks(options(), [], fetchImpl));
    expect(message).toContain(
      "https://tereo.example.test/.well-known/oauth-authorization-server"
    );
  });

  it.each([
    ["not an object", ["x"]],
    ["missing token_endpoint", { ...metadata, token_endpoint: undefined }],
    ["a non-string issuer", { ...metadata, issuer: 42 }],
  ])("fails on metadata that is %s", async (_label, body) => {
    const message = await failure(
      runStartChecks(options(), [], answering(200, body))
    );
    expect(message).toContain(
      "https://tereo.example.test/.well-known/oauth-authorization-server"
    );
  });

  // The MCP SDK allows plain http only for localhost and 127.0.0.1, not [::1].
  it.each([
    "http://tereo.example.test",
    "http://[::1]:4001",
    "not a url",
    "https://tereo.example.test/?x=1",
    "https://tereo.example.test/#frag",
  ])("fails on the issuer %s, naming it", async (issuer) => {
    const message = await failure(
      runStartChecks(options(), [], answering(200, { ...metadata, issuer }))
    );
    expect(message).toMatch(/^@tereo-io\/mcp cannot start: /);
    expect(message).toContain("issuer");
    expect(message).toContain(JSON.stringify(issuer));
  });

  it.each(["http://localhost:4001", "http://127.0.0.1:4001"])(
    "accepts the plain-http loopback issuer %s",
    async (issuer) => {
      const state = await runStartChecks(
        options(),
        [],
        answering(200, { ...metadata, issuer })
      );
      expect(state.oauthMetadata.issuer).toBe(issuer);
    }
  );

  it("accepts a plain-http issuer when the MCP SDK's insecure-issuer override is set", async () => {
    vi.stubEnv("MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL", "true");
    const issuer = "http://tereo.example.test";
    const state = await runStartChecks(
      options(),
      [],
      answering(200, { ...metadata, issuer })
    );
    expect(state.oauthMetadata.issuer).toBe(issuer);
  });

  it.each([0, -1, 1.5, Number.NaN])(
    "refuses rateLimit.perMinute %s",
    async (perMinute) => {
      const message = await failure(
        runStartChecks(
          options({ rateLimit: { perMinute } }),
          [],
          answering(200, metadata)
        )
      );
      expect(message).toContain("rateLimit.perMinute");
    }
  );

  it.each([0, -1, 1.5, Number.NaN])(
    "refuses maxResultBytes %s",
    async (maxResultBytes) => {
      const message = await failure(
        runStartChecks(
          options({ maxResultBytes }),
          [],
          answering(200, metadata)
        )
      );
      expect(message).toContain("maxResultBytes");
    }
  );

  it("accepts positive integer limits", async () => {
    await runStartChecks(
      options({ rateLimit: { perMinute: 1 }, maxResultBytes: 1 }),
      [],
      answering(200, metadata)
    );
  });

  it.each([
    "app.example.com",
    "not a url",
    "https://app.example.com/path",
    "https://app.example.com/?x=1",
    "ftp://app.example.com",
  ])("refuses the allowedOrigins entry %s, naming it", async (origin) => {
    const message = await failure(
      runStartChecks(
        options({ allowedOrigins: ["https://ok.example.com", origin] }),
        [],
        answering(200, metadata)
      )
    );
    expect(message).toContain("allowedOrigins");
    expect(message).toContain(JSON.stringify(origin));
  });

  it("accepts origins with a port or a trailing slash", async () => {
    await runStartChecks(
      options({
        allowedOrigins: ["https://app.example.com", "http://localhost:3000/"],
      }),
      [],
      answering(200, metadata)
    );
  });

  it("accepts a list of scopes", async () => {
    await runStartChecks(
      options({ scopes: ["openid", "profile", "email"] }),
      [],
      answering(200, metadata)
    );
  });

  it.each([
    ["", "scopes", "empty"],
    ["two words", "two words", "whitespace"],
    ['quo"te', "quo", "scope-token"],
  ])("refuses the scope %j", async (scope, entry) => {
    const message = await failure(
      runStartChecks(
        options({ scopes: ["openid", scope] }),
        [],
        answering(200, metadata)
      )
    );
    expect(message).toMatch(/^@tereo-io\/mcp cannot start: /);
    expect(message).toContain("scopes");
    expect(message).toContain(entry);
  });

  it("refuses a duplicate scope", async () => {
    const message = await failure(
      runStartChecks(
        options({ scopes: ["openid", "profile", "openid"] }),
        [],
        answering(200, metadata)
      )
    );
    expect(message).toContain("scopes");
    expect(message).toContain('"openid"');
  });

  it("refuses offline_access", async () => {
    const message = await failure(
      runStartChecks(
        options({ scopes: ["openid", "offline_access"] }),
        [],
        answering(200, metadata)
      )
    );
    expect(message).toContain("scopes");
    expect(message).toContain("offline_access");
    expect(message).toContain("resource server");
  });

  it("fails on metadata that is not JSON", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response("<html>", { status: 200 })
    );
    const message = await failure(runStartChecks(options(), [], fetchImpl));
    expect(message).toContain(
      "https://tereo.example.test/.well-known/oauth-authorization-server"
    );
  });
});
