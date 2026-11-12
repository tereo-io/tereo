import type { TereoMcpOptions, ToolDefinition } from "../types.js";
import { serve as serveWith, tool } from "./support/serve.js";
import { afterEach, describe, expect, it } from "vitest";
import { connect } from "./support/connect.js";

const token = "test-token-u1|client=claude|perms=";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

const serve = (extra: Partial<TereoMcpOptions>, ...tools: ToolDefinition[]) =>
  serveWith(cleanups, extra, ...tools);

describe.each(["legacy", "modern"] as const)(
  "server instructions and tool titles (%s era)",
  (era) => {
    it("gives the client the server instructions", async () => {
      const instructions = "Call list_connections before run_query.";
      const { server } = await serve({ instructions });
      const client = await connect(server.url, token, { era });

      expect(client.getInstructions()).toBe(instructions);
      await client.close();
    });

    it("gives the client no instructions when none are set", async () => {
      const { server } = await serve({});
      const client = await connect(server.url, token, { era });

      expect(client.getInstructions()).toBeUndefined();
      await client.close();
    });

    it("lists a tool's title when set, and none when unset", async () => {
      const { server } = await serve(
        {},
        tool("titled", () => "ok", { title: "Run a query" }),
        tool("untitled", () => "ok")
      );
      const client = await connect(server.url, token, { era });

      const { tools } = await client.listTools();
      const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

      expect(byName.titled.title).toBe("Run a query");
      expect(byName.untitled.title).toBeUndefined();
      expect(byName.untitled).not.toHaveProperty("title");
      await client.close();
    });
  }
);
