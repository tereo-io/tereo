// @module-tag unit
// @module-tag files
import { createDiskBlobStore } from "../../../utils/blobStore/disk.js";
import type { BlobStore } from "../../../utils/blobStore/types.js";
import { Readable } from "stream";
import fs from "fs/promises";
import path from "path";
import os from "os";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const hashOf = (prefix: string) => prefix + "0".repeat(64 - prefix.length);

const read = async (stream: Readable): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
};

const exists = (p: string) =>
  fs.stat(p).then(
    () => true,
    () => false
  );

let root: string;
let store: BlobStore;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "disk-blob-store-"));
  store = createDiskBlobStore(root);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

afterAll(() => {
  vi.restoreAllMocks();
});

const stage = async (body: string) => {
  const p = path.join(root, `staged-${Math.random().toString(16).slice(2)}`);
  await fs.writeFile(p, body);
  return p;
};

const put = async (hash: string, body = "ciphertext") => {
  const location = store.locationFor(hash);
  await store.place(await stage(body), location);
  return location;
};

describe("locationFor", () => {
  it("shards by the first two pairs of hash characters", () => {
    const hash = hashOf("ab12");
    expect(store.locationFor(hash)).toBe(
      path.join(root, "blobs", "ab", "12", hash)
    );
  });

  it("refuses a hash too short to shard", () => {
    expect(() => store.locationFor("abc")).toThrow();
  });
});

describe("place", () => {
  it("moves the staged file to the location", async () => {
    const staged = await stage("ciphertext");
    const location = store.locationFor(hashOf("ab12"));
    await store.place(staged, location);
    expect(await fs.readFile(location, "utf8")).toBe("ciphertext");
    expect(await exists(staged)).toBe(false);
  });

  it("replaces a file already at the location", async () => {
    const location = await put(hashOf("ab12"), "left by a rolled-back write");
    await store.place(await stage("ciphertext"), location);
    expect(await fs.readFile(location, "utf8")).toBe("ciphertext");
  });

  it("copies a staged file that is on another filesystem", async () => {
    const hash = hashOf("abcd");
    const location = await put(hash, "left by a write that rolled back");
    const staged = await stage("ciphertext");

    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (from === staged) {
        throw Object.assign(new Error("cross-device link not permitted"), {
          code: "EXDEV",
        });
      }
      await rename(from, to);
    });

    await store.place(staged, location);

    expect(await fs.readFile(location, "utf8")).toBe("ciphertext");
    expect(await exists(staged)).toBe(false);
    expect(await fs.readdir(path.dirname(location))).toEqual([hash]);
  });
});

describe("reading a blob", () => {
  it("streams the whole blob or an inclusive byte range", async () => {
    const location = await put(hashOf("ab12"), "0123456789");
    expect(await read(store.openRead(location))).toBe("0123456789");
    expect(await read(store.openRead(location, { start: 2, end: 4 }))).toBe(
      "234"
    );
  });

  it("returns the first bytes", async () => {
    const location = await put(hashOf("ab12"), "0123456789");
    expect((await store.readHead(location, 4)).toString()).toBe("0123");
  });

  it("reports a missing blob as missing", async () => {
    const location = store.locationFor(hashOf("ab12"));
    const headErr = await store.readHead(location, 4).catch((e) => e);
    expect(store.isMissing(headErr)).toBe(true);
    const streamErr = await read(store.openRead(location)).catch((e) => e);
    expect(store.isMissing(streamErr)).toBe(true);
    expect(store.isMissing(new Error("x"))).toBe(false);
  });
});

describe("exists and delete", () => {
  it("delete says whether it removed the blob", async () => {
    const location = await put(hashOf("ab12"));
    expect(await store.exists(location)).toBe(true);
    expect(await store.delete(location)).toBe(true);
    expect(await store.exists(location)).toBe(false);
    expect(await store.delete(location)).toBe(false);
  });
});

describe("listing", () => {
  it("lists no shards before any blob is stored", async () => {
    expect(await store.listShards()).toEqual([]);
  });

  it("lists only shard directories, sorted", async () => {
    await put(hashOf("cd00"));
    await put(hashOf("ab12"));
    await fs.mkdir(path.join(root, "blobs", "lost+found"));
    await fs.writeFile(path.join(root, "blobs", "ef"), "a file, not a shard");
    expect(await store.listShards()).toEqual(["ab", "cd"]);
  });

  const collect = async (
    shard: string,
    cursor?: Parameters<BlobStore["listBlobs"]>[1]
  ) => {
    const out = [];
    for await (const listing of store.listBlobs(shard, cursor)) {
      out.push(listing);
    }
    return out;
  };

  it("lists a shard's blobs by sub-directory then name, skipping other files", async () => {
    const h1 = hashOf("ab12a");
    const h2 = hashOf("ab12b");
    const h3 = hashOf("ab34");
    for (const h of [h3, h2, h1]) await put(h);
    await fs.writeFile(
      path.join(root, "blobs", "ab", "12", `${h1}.deadbeef.tmp`),
      "a copy in progress"
    );

    expect(await collect("ab")).toEqual([
      {
        hash: h1,
        location: store.locationFor(h1),
        cursor: { sub: "12", afterFile: h1 },
      },
      {
        hash: h2,
        location: store.locationFor(h2),
        cursor: { sub: "12", afterFile: h2 },
      },
      {
        hash: h3,
        location: store.locationFor(h3),
        cursor: { sub: "34", afterFile: h3 },
      },
    ]);
  });

  it("resumes after the cursor's file, or at the start of its sub-directory", async () => {
    const h1 = hashOf("ab12a");
    const h2 = hashOf("ab12b");
    const h3 = hashOf("ab34");
    for (const h of [h1, h2, h3]) await put(h);

    const after = await collect("ab", { sub: "12", afterFile: h1 });
    expect(after.map((l) => l.hash)).toEqual([h2, h3]);
    const fromSub = await collect("ab", { sub: "34" });
    expect(fromSub.map((l) => l.hash)).toEqual([h3]);
    const fromFirstSub = await collect("ab", { sub: "12" });
    expect(fromFirstSub.map((l) => l.hash)).toEqual([h1, h2, h3]);
  });

  it("lists nothing for a shard that does not exist", async () => {
    expect(await collect("zz")).toEqual([]);
  });
});

describe("multipart parts", () => {
  it("stores each write of a part under its own name", async () => {
    const a = await store.writePart("u1", 3, Readable.from("data"));
    const b = await store.writePart("u1", 3, Readable.from("data"));
    expect(path.dirname(a)).toBe(path.join(root, "multipart", "u1"));
    expect(path.basename(a)).toMatch(/^3\.[0-9a-f]{16}$/);
    expect(b).not.toBe(a);
    expect(await read(store.openPart(a))).toBe("data");
  });

  it("leaves no file when the source fails", async () => {
    const source = new Readable({
      read() {
        this.destroy(new Error("client went away"));
      },
    });
    await expect(store.writePart("u1", 1, source)).rejects.toThrow(
      "client went away"
    );
    expect(await fs.readdir(path.join(root, "multipart", "u1"))).toEqual([]);
  });

  it("reports a missing part as missing", async () => {
    const err = await read(
      store.openPart(path.join(root, "multipart", "u1", "1.00"))
    ).catch((e) => e);
    expect(store.isMissing(err)).toBe(true);
  });

  it("deletes a part and tolerates one already gone", async () => {
    const a = await store.writePart("u1", 1, Readable.from("data"));
    await store.deletePart(a);
    expect(await exists(a)).toBe(false);
    await expect(store.deletePart(a)).resolves.toBeUndefined();
  });

  it("releases an upload only once it holds no part", async () => {
    const dir = path.join(root, "multipart", "u1");
    const a = await store.writePart("u1", 1, Readable.from("data"));
    await store.releaseUploadIfEmpty("u1");
    expect(await exists(dir)).toBe(true);
    await store.deletePart(a);
    await store.releaseUploadIfEmpty("u1");
    expect(await exists(dir)).toBe(false);
    await expect(store.releaseUploadIfEmpty("u1")).resolves.toBeUndefined();
  });

  it("removes an upload with its parts, or one already gone", async () => {
    await store.writePart("u1", 1, Readable.from("data"));
    await store.removeUpload("u1");
    expect(await exists(path.join(root, "multipart", "u1"))).toBe(false);
    await expect(store.removeUpload("u1")).resolves.toBeUndefined();
  });
});

describe("ensureReady", () => {
  it("creates the blob root", async () => {
    await store.ensureReady();
    expect(await exists(path.join(root, "blobs"))).toBe(true);
  });
});
