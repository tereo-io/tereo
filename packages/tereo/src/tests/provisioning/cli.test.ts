import { provisioningJsonSchema } from "../../cli/provision/index.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { generateClientSecret } from "../../utils/crypto.js";
import { removeServices } from "./utils/test-helpers.js";
import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import { loadTestEnv } from "../testEnv.js";
import { spawnSync } from "child_process";
import { randomBytes } from "crypto";
import { tmpdir } from "os";
import path from "path";

const packageDir = path.resolve(import.meta.dirname, "../../..");
const dirs: string[] = [];
const slugs: string[] = [];

const cli = (args: string[], env: Record<string, string> = {}) =>
  spawnSync("npx", ["tsx", "src/cli/index.ts", ...args], {
    cwd: packageDir,
    encoding: "utf-8",
    env: { ...process.env, ...loadTestEnv(), ...env },
  });

const tempDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tereo-prov-"));
  dirs.push(dir);
  return dir;
};

const writeService = (dir: string) => {
  const slug = `cli-${randomBytes(4).toString("hex")}`;
  slugs.push(slug);
  writeFileSync(
    path.join(dir, `${slug}.json`),
    JSON.stringify({
      version: "1.0.0",
      service: { slug, name: `Service ${slug}`, secretFrom: "CLI_SECRET" },
    })
  );
  return { slug, env: { CLI_SECRET: generateClientSecret().plainSecret } };
};

const serviceExists = async (slug: string) =>
  (await prisma.service.findUnique({ where: { slug } })) !== null;

afterAll(async () => {
  await removeServices(slugs);
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("provisioning CLI", () => {
  it("applies a folder and prints what changed", async () => {
    const dir = tempDir();
    const { slug, env } = writeService(dir);
    const res = cli(["provision", "--path", dir], env);
    expect(res.status, res.stderr).toBe(0);
    expect(JSON.parse(res.stdout).created).toContain(`service:${slug}`);
    expect(await serviceExists(slug)).toBe(true);
  });

  it("--dry-run writes nothing", async () => {
    const dir = tempDir();
    const { slug, env } = writeService(dir);
    const res = cli(["provision", "--path", dir, "--dry-run"], env);
    expect(res.status, res.stderr).toBe(0);
    expect(JSON.parse(res.stdout).created).toContain(`service:${slug}`);
    expect(await serviceExists(slug)).toBe(false);
  });

  it("exits 1 listing every problem", () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "bad-one.json"), JSON.stringify({ x: 1 }));
    writeFileSync(path.join(dir, "bad-two.json"), JSON.stringify({ y: 2 }));
    const res = cli(["provision", "--path", dir]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("bad-one.json");
    expect(res.stderr).toContain("bad-two.json");
  });

  it("prints the JSON Schema", () => {
    const res = cli(["provisioning-schema"]);
    expect(res.status, res.stderr).toBe(0);
    expect(JSON.parse(res.stdout).properties.version).toBeDefined();
  });

  it("provisioning.schema.json is current", () => {
    const committed = readFileSync(
      path.join(packageDir, "provisioning.schema.json"),
      "utf-8"
    );
    expect(JSON.parse(committed)).toEqual(provisioningJsonSchema());
  });
});
