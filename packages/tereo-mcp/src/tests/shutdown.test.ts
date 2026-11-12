import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { Client } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { connect } from "./support/connect.js";
import { fileURLToPath } from "node:url";

const FIXTURE = fileURLToPath(
  new URL("./support/shutdownFixture.ts", import.meta.url)
);
const PACKAGE_DIR = fileURLToPath(new URL("../..", import.meta.url));
const token = "test-token-u1|client=claude|perms=";
const CHILD_TEST_MS = 20_000;

interface Fixture {
  child: ChildProcessWithoutNullStreams;
  url: string;
  lines: string[];
  waitFor(match: (line: string) => boolean, ms?: number): Promise<string>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const children: ChildProcessWithoutNullStreams[] = [];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(
    clients.splice(0).map((client) => client.close().catch(() => undefined))
  );
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
});

async function start(args: string[] = []): Promise<Fixture> {
  // tsx is resolved from the working directory, which reaches the root node_modules.
  const child = spawn(process.execPath, ["--import", "tsx", FIXTURE, ...args], {
    cwd: PACKAGE_DIR,
    stdio: "pipe",
  });
  children.push(child);
  const lines: string[] = [];
  const waiters = new Set<() => void>();
  let buffered = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffered += chunk;
    const parts = buffered.split("\n");
    buffered = parts.pop() ?? "";
    lines.push(...parts);
    for (const wake of waiters) wake();
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) =>
    child.once("exit", (code, signal) => {
      for (const wake of waiters) wake();
      resolve({ code, signal });
    })
  );

  const waitFor = (match: (line: string) => boolean, ms = 10_000) =>
    new Promise<string>((resolve, reject) => {
      const check = () => {
        const found = lines.find(match);
        if (found !== undefined) {
          done();
          resolve(found);
        } else if (child.exitCode !== null || child.signalCode !== null) {
          done();
          reject(
            new Error(
              `fixture exited first; stdout:\n${lines.join("\n")}\nstderr:\n${stderr}`
            )
          );
        }
      };
      const timer = setTimeout(() => {
        done();
        reject(
          new Error(
            `timed out; stdout:\n${lines.join("\n")}\nstderr:\n${stderr}`
          )
        );
      }, ms);
      const done = () => {
        clearTimeout(timer);
        waiters.delete(check);
      };
      waiters.add(check);
      check();
    });

  const ready = await waitFor((line) => line.startsWith("READY "));
  return { child, url: ready.slice("READY ".length), lines, waitFor, exited };
}

const logged = (lines: string[], msg: string) =>
  lines.some((line) => {
    try {
      return (JSON.parse(line) as { msg?: unknown }).msg === msg;
    } catch {
      return false;
    }
  });

async function client(url: string): Promise<Client> {
  const c = await connect(url, token);
  clients.push(c);
  return c;
}

async function exitWithin(fixture: Fixture, ms: number) {
  const timedOut = Symbol("timed out");
  let timer: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    fixture.exited,
    new Promise<typeof timedOut>((resolve) => {
      timer = setTimeout(() => resolve(timedOut), ms);
    }),
  ]);
  clearTimeout(timer);
  if (outcome === timedOut) {
    throw new Error(
      `fixture still running after ${ms} ms; stdout:\n${fixture.lines.join("\n")}`
    );
  }
  return outcome;
}

describe("listen shutdown on signals", () => {
  it.each(["SIGTERM", "SIGINT"] as const)(
    "%s with nothing in flight runs onShutdown and exits 0",
    async (signal) => {
      const fixture = await start();

      fixture.child.kill(signal);
      const { code } = await exitWithin(fixture, 3_000);

      expect(code).toBe(0);
      expect(fixture.lines).toContain("ONSHUTDOWN");
      expect(logged(fixture.lines, "MCP server shutting down")).toBe(true);
    },
    CHILD_TEST_MS
  );

  it(
    "SIGTERM lets an in-flight call answer, then exits 0",
    async () => {
      const fixture = await start();
      const c = await client(fixture.url);

      const call = c.callTool({ name: "slow", arguments: { ms: 300 } });
      await fixture.waitFor((line) => line === "IN slow");
      fixture.child.kill("SIGTERM");
      const result = await call;
      const { code } = await exitWithin(fixture, 3_000);

      expect(result.content).toEqual([{ type: "text", text: "slow done" }]);
      expect(code).toBe(0);
      expect(fixture.lines).toContain("ONSHUTDOWN");
    },
    CHILD_TEST_MS
  );

  it(
    "SIGTERM with a call that never answers exits 1 at the drain deadline, after onShutdown",
    async () => {
      const fixture = await start(["--timeout", "300"]);
      const c = await client(fixture.url);

      void c
        .callTool({ name: "hang", arguments: {} }, { timeout: 10_000 })
        .catch(() => undefined);
      await fixture.waitFor((line) => line === "IN hang");
      fixture.child.kill("SIGTERM");
      const { code } = await exitWithin(fixture, 3_000);

      expect(code).toBe(1);
      expect(fixture.lines).toContain("ONSHUTDOWN");
    },
    CHILD_TEST_MS
  );

  it(
    "a second SIGTERM while draining exits 1 at once",
    async () => {
      const fixture = await start(["--timeout", "60000"]);
      const c = await client(fixture.url);

      void c
        .callTool({ name: "hang", arguments: {} }, { timeout: 10_000 })
        .catch(() => undefined);
      await fixture.waitFor((line) => line === "IN hang");
      fixture.child.kill("SIGTERM");
      await fixture.waitFor((line) =>
        logged([line], "MCP server shutting down")
      );
      fixture.child.kill("SIGTERM");
      const { code } = await exitWithin(fixture, 1_500);

      expect(code).toBe(1);
      expect(logged(fixture.lines, "MCP server forced to exit")).toBe(true);
      expect(fixture.lines).not.toContain("ONSHUTDOWN");
    },
    CHILD_TEST_MS
  );

  it(
    "exits 1 and logs the failure when onShutdown throws",
    async () => {
      const fixture = await start(["--throw-on-shutdown"]);

      fixture.child.kill("SIGTERM");
      const { code } = await exitWithin(fixture, 3_000);

      expect(code).toBe(1);
      expect(fixture.lines).toContain("ONSHUTDOWN");
      expect(logged(fixture.lines, "MCP server shutdown failed")).toBe(true);
    },
    CHILD_TEST_MS
  );

  it(
    "exits 1 when onShutdown has not settled by shutdownTimeoutMs",
    async () => {
      const fixture = await start(["--timeout", "300", "--hang-on-shutdown"]);

      fixture.child.kill("SIGTERM");
      const { code } = await exitWithin(fixture, 3_000);

      expect(code).toBe(1);
      expect(fixture.lines).toContain("ONSHUTDOWN");
      expect(logged(fixture.lines, "MCP server shutdown timed out")).toBe(true);
    },
    CHILD_TEST_MS
  );
});
