import { serveWithResources, tool } from "./support/serve.js";
import { afterEach, describe, expect, it } from "vitest";
import { fakeCore } from "./support/fakeCore.js";
import { createTereoMcp } from "../tereoMcp.js";
import { connect } from "./support/connect.js";
import { z } from "zod";
import type {
  ResourceDefinition,
  TereoMcpOptions,
  ToolDefinition,
} from "../types.js";

const token = "test-token-u1|client=claude|perms=";
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

const resourceFor = (uri: string): ResourceDefinition => ({
  uri,
  name: uri.replace(/\W/g, "_"),
  mimeType: "text/html;profile=mcp-app",
  read: () => ({ text: "<p>hi</p>" }),
});

// Every ui the tests use points at a resource defined here.
const serve = (extra: Partial<TereoMcpOptions>, ...tools: ToolDefinition[]) =>
  serveWithResources(
    cleanups,
    extra,
    tools,
    ["ui://app/card.html", "ui://app/other.html"].map(resourceFor)
  );

const ui: ToolDefinition["ui"] = {
  resourceUri: "ui://app/card.html",
  visibility: ["app"],
};

describe.each(["legacy", "modern"] as const)("tool ui (%s era)", (era) => {
  it("lists a tool's ui as _meta.ui and the flat ui/resourceUri key", async () => {
    const { server } = await serve(
      { rateLimit: false },
      tool("plain", () => "x", {
        ui: { resourceUri: "ui://app/card.html", visibility: ["model", "app"] },
      }),
      tool("typed", () => "x", {
        input: z.object({ id: z.string() }),
        ui: { resourceUri: "ui://app/other.html" },
      })
    );
    const client = await connect(server.url, token, { era });

    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    expect(byName.plain._meta).toEqual({
      "ui/resourceUri": "ui://app/card.html",
      ui: { resourceUri: "ui://app/card.html", visibility: ["model", "app"] },
    });
    expect(byName.typed._meta).toEqual({
      "ui/resourceUri": "ui://app/other.html",
      ui: { resourceUri: "ui://app/other.html" },
    });
    await client.close();
  });

  it("lists no _meta for a tool without ui", async () => {
    const { server } = await serve(
      { rateLimit: false },
      tool("plain", () => "x"),
      tool("typed", () => "x", { input: z.object({ id: z.string() }) })
    );
    const client = await connect(server.url, token, { era });

    const { tools } = await client.listTools();

    for (const t of tools) expect(t._meta).toBeUndefined();
    await client.close();
  });

  it("still checks the permission of an app-only tool", async () => {
    const { server } = await serve(
      { rateLimit: false },
      tool("secret", () => "ran", { permission: "q.items.write", ui })
    );
    const client = await connect(server.url, token, { era });

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([]);
    const result = await client
      .callTool({ name: "secret" })
      .catch((e: unknown) => ({ thrown: String(e) }));
    expect(JSON.stringify(result)).not.toContain("ran");
    await client.close();

    const allowed = await connect(
      server.url,
      "test-token-u1|client=claude|perms=q.items.write",
      { era }
    );
    expect((await allowed.listTools()).tools[0]._meta).toEqual({
      "ui/resourceUri": "ui://app/card.html",
      ui: { resourceUri: "ui://app/card.html", visibility: ["app"] },
    });
    expect((await allowed.callTool({ name: "secret" })).content).toEqual([
      { type: "text", text: "ran" },
    ]);
    await allowed.close();
  });
});

describe("tool ui definition checks", () => {
  const define = (uiValue: unknown) => () => {
    const mcp = createTereoMcp({
      name: "quotes",
      version: "1.0.0",
      core: fakeCore(),
      publicUrl: "https://mcp.example.test",
      allowedClients: ["claude"],
    });
    mcp.define(tool("t", () => "x", { ui: uiValue as never }));
  };

  it("refuses a resourceUri that is not ui://", () => {
    expect(define({ resourceUri: "https://x.test/a" })).toThrow(/ui:\/\//);
    expect(define({ resourceUri: 5 })).toThrow(/ui:\/\//);
    expect(define("ui://a")).toThrow(/ui/);
  });

  it("refuses an empty, duplicated or unknown visibility", () => {
    const resourceUri = "ui://app/a.html";
    expect(define({ resourceUri, visibility: [] })).toThrow(/visibility/);
    expect(define({ resourceUri, visibility: ["app", "app"] })).toThrow(
      /visibility/
    );
    expect(define({ resourceUri, visibility: ["x"] })).toThrow(/visibility/);
    expect(define({ resourceUri, visibility: "app" })).toThrow(/visibility/);
  });

  it("accepts a valid ui", () => {
    expect(
      define({ resourceUri: "ui://app/a.html", visibility: ["model", "app"] })
    ).not.toThrow();
  });
});
