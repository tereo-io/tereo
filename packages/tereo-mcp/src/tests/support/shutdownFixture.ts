// Run as a child process by shutdown.test.ts:
//   node --import tsx shutdownFixture.ts [--timeout <ms>] [--throw-on-shutdown] [--hang-on-shutdown]
// Markers go to fd 1 with writeSync so they survive process.exit on a pipe.
import { createTereoMcp } from "../../tereoMcp.js";
import { startStubCore } from "../../testing.js";
import { fakeCore } from "./fakeCore.js";
import { writeSync } from "node:fs";
import { z } from "zod";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const out = (line: string) => writeSync(1, `${line}\n`);

const stub = await startStubCore();
const mcp = createTereoMcp({
  name: "quotes",
  version: "1.0.0",
  core: fakeCore(),
  publicUrl: "https://mcp.example.test",
  allowedClients: ["claude"],
  rateLimit: false,
  coreUrl: stub.coreUrl,
});
mcp.define<{ ms?: number }>({
  name: "slow",
  description: "Answers after ms milliseconds",
  permission: null,
  readOnly: true,
  input: z.object({ ms: z.number().int().nonnegative().optional() }),
  handler: async ({ ms = 300 }) => {
    out("IN slow");
    await new Promise((resolve) => setTimeout(resolve, ms));
    return "slow done";
  },
});
mcp.define({
  name: "hang",
  description: "Never answers",
  permission: null,
  readOnly: true,
  input: z.object({}),
  handler: () => {
    out("IN hang");
    return new Promise(() => undefined);
  },
});

const timeout = value("--timeout");
const server = await mcp.listen(0, "127.0.0.1", {
  shutdownTimeoutMs: timeout === undefined ? undefined : Number(timeout),
  onShutdown: async () => {
    out("ONSHUTDOWN");
    await stub.close();
    if (flag("--throw-on-shutdown")) throw new Error("onShutdown failed");
    if (flag("--hang-on-shutdown")) await new Promise(() => undefined);
  },
});
out(`READY ${server.url}`);
