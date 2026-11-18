import type { ResourceDefinition, TereoMcpOptions } from "../types.js";
import { afterEach, describe, expect, it } from "vitest";
import { fakeCore } from "./support/fakeCore.js";
import { createTereoMcp } from "../tereoMcp.js";
import { startStubCore } from "../testing.js";
import pino from "pino";
import { connect } from "./support/connect.js";

const token = "test-token-u1|client=claude|perms=";
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

const card = (extra: Partial<ResourceDefinition> = {}): ResourceDefinition => ({
  uri: "ui://app/card.html",
  name: "card",
  title: "Card",
  description: "A card",
  mimeType: "text/html;profile=mcp-app",
  meta: { ui: { csp: { connectDomains: [] } } },
  read: () => ({ text: "<p>hi</p>" }),
  ...extra,
});

const serveResources = async (
  resources: ResourceDefinition[],
  extra: Partial<TereoMcpOptions> = {}
) => {
  const stub = await startStubCore();
  cleanups.push(() => stub.close());
  const lines: Record<string, unknown>[] = [];
  const logger = pino({ level: "debug" }, {
    write: (s: string) => lines.push(JSON.parse(s)),
  } as never);
  const mcp = createTereoMcp({
    name: "quotes",
    version: "1.0.0",
    core: fakeCore(),
    publicUrl: "https://mcp.example.test",
    allowedClients: ["claude"],
    rateLimit: false,
    coreUrl: stub.coreUrl,
    logger,
    ...extra,
  });
  for (const r of resources) mcp.resource(r);
  const server = await mcp.listen(0, "127.0.0.1", { signals: false });
  cleanups.push(() => server.close());
  return { server, lines, mcp };
};

describe.each(["legacy", "modern"] as const)("resources (%s era)", (era) => {
  it("lists a defined resource with its mimeType and _meta", async () => {
    const { server } = await serveResources([card()]);
    const client = await connect(server.url, token, { era });

    const { resources } = await client.listResources();

    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({
      uri: "ui://app/card.html",
      name: "card",
      mimeType: "text/html;profile=mcp-app",
      _meta: { ui: { csp: { connectDomains: [] } } },
    });
    await client.close();
  });

  it("reads its text", async () => {
    const { server } = await serveResources([card()]);
    const client = await connect(server.url, token, { era });

    const result = await client.readResource({ uri: "ui://app/card.html" });

    expect(result.contents).toHaveLength(1);
    expect(result.contents[0]).toMatchObject({
      uri: "ui://app/card.html",
      mimeType: "text/html;profile=mcp-app",
      text: "<p>hi</p>",
      _meta: { ui: { csp: { connectDomains: [] } } },
    });
    await client.close();
  });

  it("lists it for a caller without any permission", async () => {
    const { server } = await serveResources([card()]);
    const client = await connect(
      server.url,
      "test-token-u9|client=claude|perms=",
      {
        era,
      }
    );

    const { resources } = await client.listResources();

    expect(resources.map((r) => r.uri)).toEqual(["ui://app/card.html"]);
    await client.close();
  });

  it("answers an error when read() throws, and logs it", async () => {
    const { server, lines } = await serveResources([
      card({
        read: () => {
          throw new Error("secret db detail");
        },
      }),
    ]);
    const client = await connect(server.url, token, { era });

    await expect(
      client.readResource({ uri: "ui://app/card.html" })
    ).rejects.toThrow();
    await client.close();

    const logged = lines.find((l) => l.msg === "MCP resource read failed");
    expect(logged).toMatchObject({ level: 50, resource: "ui://app/card.html" });
  });

  it("declares no resources capability when none is defined", async () => {
    const { server } = await serveResources([]);
    const client = await connect(server.url, token, { era });

    expect(client.getServerCapabilities()?.resources).toBeUndefined();
    await client.close();
  });

  it("declares the resources capability when one is defined", async () => {
    const { server } = await serveResources([card()]);
    const client = await connect(server.url, token, { era });

    expect(client.getServerCapabilities()?.resources).toBeDefined();
    await client.close();
  });
});

describe("resource definition", () => {
  it("refuses a second resource with the same uri", () => {
    const mcp = createTereoMcp({
      name: "quotes",
      version: "1.0.0",
      core: fakeCore(),
      publicUrl: "https://mcp.example.test",
      allowedClients: ["claude"],
    });
    mcp.resource(card());
    expect(() => mcp.resource(card({ name: "other" }))).toThrow(
      /already defined/
    );
  });
});
