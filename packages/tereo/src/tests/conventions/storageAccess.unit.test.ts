// @module-tag unit
// @module-tag files
import { readdirSync, readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "url";
import path from "path";

// Blob and multipart-part bytes are reached through `utils/blobStore`, and a
// request's temp files through `utils/scratchFiles`, so another blob backend
// is one more implementation of the first. The files below touch the
// filesystem for those two, or for something that is not blob storage.
const SRC = fileURLToPath(new URL("../..", import.meta.url));

const ALLOWED: Record<string, string> = {
  "utils/blobStore/disk.ts": "the disk blob store",
  "utils/blobStore/index.ts": "hands the disk blob store its root",
  "utils/scratchFiles.ts": "owns the temp directory",
  "env.ts": "declares the two path settings",
  "telemetry/index.ts": "reads the package version",
  "utils/version.ts": "reads the package version",
  "utils/provisioning/load.ts": "reads provisioning documents",
  "utils/provisioning/branding.ts": "reads branding images a document names",
  "routes/controllers.ts": "serves the admin UI's build",
};

const FS_ACCESS =
  /from\s+"(node:)?fs(\/promises)?"|FILE_SERVICE_(STORAGE|TEMP)_PATH/;

const files = readdirSync(SRC, { recursive: true, encoding: "utf8" })
  .map((f) => f.split(path.sep).join("/"))
  .filter((f) => f.endsWith(".ts") && !f.startsWith("tests/"));

const touches = (f: string) =>
  FS_ACCESS.test(readFileSync(path.join(SRC, f), "utf8"));

describe("storage access", () => {
  it("finds the source files", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it.each([
    'import fs from "fs/promises";',
    'import { createReadStream } from "fs";',
    'import type { ReadStream } from "node:fs";',
    'import { access } from "node:fs/promises";',
    "path.join(env.FILE_SERVICE_STORAGE_PATH, name)",
    "cb(null, env.FILE_SERVICE_TEMP_PATH)",
  ])("catches %j", (code) => {
    expect(FS_ACCESS.test(code)).toBe(true);
  });

  it.each([
    'import { blobStore } from "../utils/blobStore/index.js";',
    'import { discardScratchFile } from "./scratchFiles.js";',
    "fsPath: blob.fsPath,",
  ])("ignores %j", (code) => {
    expect(FS_ACCESS.test(code)).toBe(false);
  });

  it("touches the filesystem only in the allowlisted files", () => {
    const offending = files
      .filter((f) => !(f in ALLOWED) && touches(f))
      .map(
        (f) =>
          `${f} touches the filesystem: use utils/blobStore or utils/scratchFiles`
      );
    expect(offending).toEqual([]);
  });

  it("allowlists only files that still touch it", () => {
    const stale = Object.keys(ALLOWED).filter(
      (f) => !files.includes(f) || !touches(f)
    );
    expect(stale).toEqual([]);
  });
});
