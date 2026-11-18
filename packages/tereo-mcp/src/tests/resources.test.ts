import type { ResourceDefinition, TereoMcpOptions } from "../types.js";
import { afterEach, describe, expect, it } from "vitest";
import { serveWithResources } from "./support/serve.js";
import { fakeRedis } from "./support/fakeRedis.js";
import { fakeCore } from "./support/fakeCore.js";
import { createTereoMcp } from "../tereoMcp.js";
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

const unstarted = () =>
  createTereoMcp({
    name: "quotes",
    version: "1.0.0",
    core: fakeCore(),
    publicUrl: "https://mcp.example.test",
    allowedClients: ["claude"],
  });

const serveResources = (
  resources: ResourceDefinition[],
  extra: Partial<TereoMcpOptions> = {}
) => serveWithResources(cleanups, extra, [], resources);

const failure = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => undefined,
    (e: unknown) => e
  );

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

    const failure = await client
      .readResource({ uri: "ui://app/card.html" })
      .then(
        () => undefined,
        (e: unknown) => e
      );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain("secret db detail");
    await client.close();

    const logged = lines.find((l) => l.msg === "MCP resource read failed");
    expect(logged).toMatchObject({ level: 50, resource: "ui://app/card.html" });
  });

  it.each([{}, { text: 123 }, { blob: undefined }, null])(
    "answers an error when read() returns %j, and logs it",
    async (returned) => {
      const { server, lines } = await serveResources([
        card({ read: () => returned as never }),
      ]);
      const client = await connect(server.url, token, { era });

      const err = await failure(
        client.readResource({ uri: "ui://app/card.html" })
      );
      expect(err).toBeInstanceOf(Error);
      await client.close();

      const logged = lines.find((l) => l.msg === "MCP resource read failed");
      expect(logged).toMatchObject({
        level: 50,
        resource: "ui://app/card.html",
      });
    }
  );

  it("ends a read that runs past toolTimeoutMs, with a warning", async () => {
    let seen: AbortSignal | undefined;
    const { server, lines } = await serveResources(
      [
        card({
          read: (ctx) => {
            seen = ctx.signal;
            return new Promise<never>(() => undefined);
          },
        }),
      ],
      { toolTimeoutMs: 50 }
    );
    const client = await connect(server.url, token, { era });

    const err = await failure(
      client.readResource({ uri: "ui://app/card.html" })
    );
    expect(err).toBeInstanceOf(Error);
    expect(seen?.aborted).toBe(true);
    await client.close();

    expect(
      lines.find((l) => l.msg === "MCP resource read timed out")
    ).toMatchObject({ level: 40, resource: "ui://app/card.html" });
    expect(lines.find((l) => l.msg === "MCP resource read failed")).toBe(
      undefined
    );
  });

  it("refuses a read larger than maxResultBytes", async () => {
    const { server, lines } = await serveResources(
      [card({ read: () => ({ text: "x".repeat(11) }) })],
      { maxResultBytes: 10 }
    );
    const client = await connect(server.url, token, { era });

    const err = await failure(
      client.readResource({ uri: "ui://app/card.html" })
    );
    expect((err as Error).message).toContain(
      "Resource too large (11 bytes; limit 10)"
    );
    await client.close();

    expect(
      lines.find((l) => l.msg === "MCP resource read refused")
    ).toMatchObject({ level: 40, resource: "ui://app/card.html" });
  });

  it("counts reads toward the server-wide rate limit", async () => {
    let reads = 0;
    const { server } = await serveResources(
      [
        card({
          read: () => {
            reads++;
            return { text: "<p>hi</p>" };
          },
        }),
      ],
      { redis: fakeRedis(), rateLimit: { perMinute: 1 } }
    );
    const client = await connect(server.url, token, { era });

    await client.readResource({ uri: "ui://app/card.html" });
    const err = await failure(
      client.readResource({ uri: "ui://app/card.html" })
    );
    expect((err as Error).message).toContain(
      "Rate limit reached; retry in 42 seconds"
    );
    expect(reads).toBe(1);
    await client.close();
  });

  it("reads a resource whose uri is already normalised", async () => {
    const { server } = await serveResources([
      card({ uri: "ui://app/panel-card.html" }),
    ]);
    const client = await connect(server.url, token, { era });

    const res = await client.readResource({
      uri: "ui://app/panel-card.html",
    });

    expect(res.contents[0]).toMatchObject({ text: "<p>hi</p>" });
    await client.close();
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
  it("refuses a uri that is not an absolute, normalised URL", () => {
    const mcp = unstarted();
    expect(() => mcp.resource(card({ uri: "card" }))).toThrow(
      'resource uri "card" must be an absolute, normalised URL'
    );
    expect(() => mcp.resource(card({ uri: "ui://app/a b.html" }))).toThrow(
      /normalised URL/
    );
  });

  it("refuses a title, description or meta of the wrong kind", () => {
    const mcp = unstarted();
    expect(() => mcp.resource(card({ title: 5 as never }))).toThrow(/title/);
    expect(() => mcp.resource(card({ title: " " }))).toThrow(/title/);
    expect(() => mcp.resource(card({ description: {} as never }))).toThrow(
      /description/
    );
    expect(() => mcp.resource(card({ meta: "x" as never }))).toThrow(/meta/);
    expect(() => mcp.resource(card({ meta: [] as never }))).toThrow(/meta/);
    expect(() => mcp.resource(card({ meta: null as never }))).toThrow(/meta/);
  });

  it("refuses a second resource with the same uri", () => {
    const mcp = unstarted();
    mcp.resource(card());
    expect(() => mcp.resource(card({ name: "other" }))).toThrow(
      /already defined/
    );
  });
});
