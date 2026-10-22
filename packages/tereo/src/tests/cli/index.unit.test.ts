// @module-tag unit
// @module-tag platform
import { describe, expect, it } from "vitest";
import { execFile } from "child_process";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";

/**
 * Runs `npm run cli` as an operator would, from a shell that sets neither
 * LOG_LEVEL nor SERVICE_NAME: preload supplies both, and logger.ts throws at
 * import time without them.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

const packageRoot = path.resolve(here, "../../..");

const cliScript = path.join(packageRoot, "src/cli/index.ts");

const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");

const shellEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name, value]) =>
      value !== undefined && name !== "LOG_LEVEL" && name !== "SERVICE_NAME"
  )
) as Record<string, string>;

const runCli = (args: string[]) =>
  new Promise<{ code: number; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      [tsxCli, cliScript, ...args],
      {
        cwd: packageRoot,
        env: { ...shellEnv, NODE_OPTIONS: "" },
        timeout: 60_000,
      },
      (err, _stdout, stderr) => {
        const code = (err as { code?: unknown } | null)?.code;
        resolve({
          code: typeof code === "number" ? code : err ? 1 : 0,
          stderr,
        });
      }
    );
  });

describe("operator CLI", () => {
  it("starts without LOG_LEVEL or SERVICE_NAME in the environment", async () => {
    const { code, stderr } = await runCli(["--help"]);
    expect(stderr).not.toMatch(/is not defined in environment variables/);
    expect(stderr).toMatch(/rewrap-master-key/);
    expect(code).toBe(0);
  }, 60_000);

  it.each([[["--dry-run", "--limit", "abc"]], [["--dryrun"]]])(
    "exits 1 with usage on rewrap-master-key %j instead of running",
    async (args) => {
      const { code, stderr } = await runCli(["rewrap-master-key", ...args]);
      expect(stderr).toMatch(/Usage: npm run cli -- rewrap-master-key/);
      expect(code).toBe(1);
    },
    60_000
  );
});
