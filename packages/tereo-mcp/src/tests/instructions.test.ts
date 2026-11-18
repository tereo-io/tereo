import { serve as serveWith, tool } from "./support/serve.js";
import { afterEach, describe, expect, it } from "vitest";
import { fakeCore } from "./support/fakeCore.js";
import { createTereoMcp } from "../tereoMcp.js";
import { connect } from "./support/connect.js";
import { startStubCore } from "../testing.js";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import express from "express";
import pino from "pino";
import type {
  InstructionsContext,
  TereoMcpOptions,
  ToolDefinition,
} from "../types.js";

const token = "test-token-u1|client=claude|perms=";
const otherToken = "test-token-u2|client=claude|perms=";

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

    it("gives each caller the instructions their function builds", async () => {
      const { server } = await serve({
        instructions: (ctx) => `hello ${ctx.auth.userId}`,
      });
      const first = await connect(server.url, token, { era });
      const second = await connect(server.url, otherToken, { era });

      expect(first.getInstructions()).toBe("hello u1");
      expect(second.getInstructions()).toBe("hello u2");
      await first.close();
      await second.close();
    });

    it("calls the function only when answering initialize or discover", async () => {
      let calls = 0;
      const { server } = await serve(
        {
          instructions: async () => {
            calls++;
            return "Use echo.";
          },
        },
        tool("echo", () => "ok")
      );
      const client = await connect(server.url, token, { era });
      await client.listTools();
      await client.callTool({ name: "echo", arguments: {} });

      expect(client.getInstructions()).toBe("Use echo.");
      expect(calls).toBe(1);
      await client.close();
    });

    it("sends no instructions when the function throws", async () => {
      const { server, lines } = await serve(
        {
          instructions: () => {
            throw new Error("catalogue unavailable");
          },
        },
        tool("echo", () => "ok")
      );
      const client = await connect(server.url, token, { era });

      expect(client.getInstructions()).toBeUndefined();
      const result = await client.callTool({ name: "echo", arguments: {} });
      expect(result.isError).toBeFalsy();
      const failed = lines.find((l) => l.msg === "MCP instructions failed");
      expect(failed).toMatchObject({ level: 50, user_id: "u1" });
      await client.close();
    });

    it.each(["", "  \n"])(
      "sends no instructions when the function returns %j",
      async (blank) => {
        const { server, lines } = await serve({ instructions: () => blank });
        const client = await connect(server.url, token, { era });

        expect(client.getInstructions()).toBeUndefined();
        const failed = lines.find((l) => l.msg === "MCP instructions failed");
        expect(failed).toMatchObject({ level: 50, user_id: "u1" });
        await client.close();
      }
    );

    it(
      "sends no instructions when the function takes longer than 2 s",
      { timeout: 10_000 },
      async () => {
        let seen: InstructionsContext | undefined;
        const { server, lines } = await serve(
          {
            instructions: async (ctx) => {
              seen = ctx;
              await new Promise((resolve) => setTimeout(resolve, 2_300));
              return "too late";
            },
          },
          tool("echo", () => "ok")
        );
        const client = await connect(server.url, token, { era });

        expect(client.getInstructions()).toBeUndefined();
        expect(seen?.signal.aborted).toBe(true);
        const result = await client.callTool({ name: "echo", arguments: {} });
        expect(result.isError).toBeFalsy();
        const failed = lines.find((l) => l.msg === "MCP instructions failed");
        expect(failed).toMatchObject({ level: 50, user_id: "u1" });
        await client.close();
      }
    );

    it("logs a warning, not an error, when the server closes during the function", async () => {
      let started!: () => void;
      const running = new Promise<void>((resolve) => (started = resolve));
      const { server, lines } = await serve(
        {
          instructions: async (ctx) => {
            started();
            await new Promise<void>((resolve) =>
              ctx.signal.addEventListener("abort", () => resolve())
            );
            return "too late";
          },
        },
        tool("echo", () => "ok")
      );
      const pending = connect(server.url, token, { era }).catch(
        () => undefined
      );

      await running;
      await server.close();
      await pending;

      expect(
        lines.find((l) => l.msg === "MCP instructions stopped: server closing")
      ).toMatchObject({ level: 40, user_id: "u1" });
      expect(lines.find((l) => l.msg === "MCP instructions failed")).toBe(
        undefined
      );
    });

    it("calls the function when the body was not parsed by the host", async () => {
      const stub = await startStubCore();
      cleanups.push(() => stub.close());
      // A host app with no express.json(): the MCP route reads the body itself.
      const app = express();
      const http = createServer(app);
      await new Promise<void>((resolve) =>
        http.listen(0, "127.0.0.1", resolve)
      );
      cleanups.push(
        () => new Promise<void>((resolve) => http.close(() => resolve()))
      );
      const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
      const mcp = createTereoMcp({
        name: "quotes",
        version: "1.0.0",
        core: fakeCore(),
        publicUrl: base,
        allowedClients: ["claude"],
        rateLimit: false,
        coreUrl: stub.coreUrl,
        logger: pino({ level: "silent" }),
        instructions: (ctx) => `hello ${ctx.auth.userId}`,
      });
      mcp.define(tool("echo", () => "ok"));
      app.use(await mcp.router());

      const client = await connect(`${base}/mcp`, token, { era });

      expect(client.getInstructions()).toBe("hello u1");
      const result = await client.callTool({ name: "echo", arguments: {} });
      expect(result.isError).toBeFalsy();
      await client.close();
    });
  }
);
