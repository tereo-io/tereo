// @module-tag unit
// @module-tag files
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { finished } from "stream/promises";
import fs from "fs/promises";
import path from "path";
import os from "os";

type ScratchFiles = typeof import("../../utils/scratchFiles.js");

let scratch: ScratchFiles;
let root: string;
let dir: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "scratch-files-"));
  dir = path.join(root, "temp");
  // env.ts reads the environment when it is first imported.
  process.env.FILE_SERVICE_TEMP_PATH = dir;
  scratch = await import("../../utils/scratchFiles.js");
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const write = async (kind: "upload" | "signed-upload" | "mp-complete") => {
  const file = await scratch.createScratchFile(kind);
  file.stream.end("abc");
  await finished(file.stream);
  return file.path;
};

describe("scratchName", () => {
  it.each(["upload", "signed-upload", "mp-complete"] as const)(
    "names a %s file as the sweep expects, uniquely",
    (kind) => {
      const name = scratch.scratchName(kind);
      expect(name).toMatch(/^(upload|signed-upload|mp-complete)-[0-9a-f]{24}$/);
      expect(name.startsWith(`${kind}-`)).toBe(true);
      expect(scratch.scratchName(kind)).not.toBe(name);
    }
  );
});

describe("createScratchFile", () => {
  it("creates the directory and a file the stream writes to", async () => {
    const p = await write("upload");
    expect(path.dirname(p)).toBe(scratch.scratchDir());
    expect(path.basename(p)).toMatch(/^upload-[0-9a-f]{24}$/);
    expect(await fs.readFile(p, "utf8")).toBe("abc");
  });
});

describe("reading a scratch file", () => {
  it("returns the first bytes, or the whole file when it is shorter", async () => {
    const p = await write("upload");
    expect((await scratch.readScratchHead(p, 2)).toString()).toBe("ab");
    expect((await scratch.readScratchHead(p, 10)).toString()).toBe("abc");
  });

  it("streams the file", async () => {
    const p = await write("upload");
    const chunks: Buffer[] = [];
    for await (const chunk of scratch.openScratchRead(p)) {
      chunks.push(chunk as Buffer);
    }
    expect(Buffer.concat(chunks).toString()).toBe("abc");
  });
});

describe("discardScratchFile", () => {
  it("removes the file and tolerates one already gone", async () => {
    const p = await write("upload");
    await scratch.discardScratchFile(p);
    await expect(fs.stat(p)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(scratch.discardScratchFile(p)).resolves.toBeUndefined();
  });
});

describe("sweepStaleScratchFiles", () => {
  it("removes only core's own files past the age", async () => {
    const now = Date.now();
    await fs.mkdir(dir, { recursive: true });
    const at = async (name: string, ageMs: number) => {
      const p = path.join(dir, name);
      await fs.writeFile(p, "x");
      const t = new Date(now - ageMs);
      await fs.utimes(p, t, t);
      return p;
    };
    const old = await at("upload-0a1b2c", 5000);
    const young = await at("signed-upload-0a1b2c", 10);
    const foreign = await at("notes.txt", 5000);
    const folder = path.join(dir, "mp-complete-abc");
    await fs.mkdir(folder);
    const t = new Date(now - 5000);
    await fs.utimes(folder, t, t);

    expect(await scratch.sweepStaleScratchFiles(1000, now)).toBe(1);

    await expect(fs.stat(old)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(young)).resolves.toBeDefined();
    await expect(fs.stat(foreign)).resolves.toBeDefined();
    await expect(fs.stat(folder)).resolves.toBeDefined();
  });

  it("stops when told to, leaving the rest for the next run", async () => {
    const now = Date.now();
    await fs.mkdir(dir, { recursive: true });
    const p = path.join(dir, "upload-0a1b2c");
    await fs.writeFile(p, "x");
    const t = new Date(now - 5000);
    await fs.utimes(p, t, t);

    expect(await scratch.sweepStaleScratchFiles(1000, now, () => true)).toBe(0);
    await expect(fs.stat(p)).resolves.toBeDefined();
  });

  it("finds nothing when the directory does not exist", async () => {
    expect(await scratch.sweepStaleScratchFiles(1000)).toBe(0);
  });
});
