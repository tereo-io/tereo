import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileServiceClient } from "../clients/files.js";
import { useCacheRedis } from "../utils/cache.js";
import { logger } from "../utils/logger.js";
import type { Redis } from "ioredis";
import { Readable } from "stream";
import {
  readUpTo,
  resolveUploadOptions,
  uploadMultipart,
} from "../utils/multipartUpload.js";

const { mockRedis, mockRequests } = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    mockRedis: {
      store,
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
        return "OK";
      }),
      del: vi.fn(async (...keys: string[]) => {
        for (const k of keys) store.delete(k);
        return keys.length;
      }),
    },
    mockRequests: {
      files: {
        uploadObject: vi.fn(),
        initiateMultipart: vi.fn(),
        uploadPart: vi.fn(),
        completeMultipart: vi.fn(),
        abortMultipart: vi.fn(),
      },
    },
  };
});

vi.mock("../handler.js", () => ({
  requests: mockRequests,
  getOriginalStatus: vi.fn(
    (err: unknown) => (err as { originalStatus?: number })?.originalStatus
  ),
}));

const MiB = 1024 * 1024;
const UPLOAD_ID = "upl-1";
const OBJECT = { id: "obj-1", key: "k", etag: "etag-1" };

const SEED = Buffer.from(Array.from({ length: 251 }, (_, i) => i));
const pattern = (size: number): Buffer => Buffer.alloc(size, SEED);

/** A byte-mode stream that hands out `source` in `chunkSize` pieces. */
const streamOf = (
  source: Buffer,
  chunkSize = 64 * 1024,
  failAfter?: { bytes: number; err: Error }
): Readable => {
  let offset = 0;
  return new Readable({
    read() {
      if (failAfter && offset >= failAfter.bytes) {
        this.destroy(failAfter.err);
        return;
      }
      if (offset >= source.length) {
        this.push(null);
        return;
      }
      this.push(source.subarray(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const partResponse = (partNumber: number, body: Buffer) => ({
  partNumber,
  etag: `e${partNumber}`,
  sizeBytes: String(body.length),
  minPartSize: 5 * MiB,
});

const partBodies = (): Buffer[] =>
  mockRequests.files.uploadPart.mock.calls.map(
    (call) => (call[3] as { body: Buffer }).body
  );

/** Hands out the first `bytes` of `source`, then never pushes again. */
const stallingStreamOf = (source: Buffer, bytes: number): Readable => {
  let offset = 0;
  return new Readable({
    read() {
      if (offset >= bytes) return;
      this.push(source.subarray(offset, offset + 64 * 1024));
      offset += 64 * 1024;
    },
  });
};

const client = () =>
  new FileServiceClient({
    multipartThresholdBytes: 10 * MiB,
    partSizeBytes: 5 * MiB,
    partConcurrency: 2,
  });

beforeEach(() => {
  useCacheRedis(mockRedis as unknown as Redis);
  mockRedis.store.clear();
  vi.clearAllMocks();
  delete process.env.NODE_ENV;
  mockRequests.files.uploadObject.mockResolvedValue(OBJECT);
  mockRequests.files.initiateMultipart.mockResolvedValue({
    uploadId: UPLOAD_ID,
  });
  mockRequests.files.uploadPart.mockImplementation(
    async (_b: string, _u: string, n: number, input: { body: Buffer }) =>
      partResponse(n, input.body)
  );
  mockRequests.files.completeMultipart.mockResolvedValue(OBJECT);
  mockRequests.files.abortMultipart.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readUpTo", () => {
  it("leaves the rest of a chunk that crosses the limit readable", async () => {
    const source = pattern(10);
    const stream = streamOf(source, 10);

    const { head, ended } = await readUpTo(stream, 4);
    expect(head.equals(source.subarray(0, 4))).toBe(true);
    expect(ended).toBe(false);

    const rest: Buffer[] = [];
    for await (const chunk of stream) rest.push(chunk as Buffer);
    expect(Buffer.concat(rest).equals(source.subarray(4))).toBe(true);
  });

  it("resolves an empty stream as ended without hanging", async () => {
    const { head, ended } = await readUpTo(Readable.from([]), 4);
    expect(head.length).toBe(0);
    expect(ended).toBe(true);
  });

  it("reports a stream shorter than the limit as ended", async () => {
    const source = pattern(100);
    const { head, ended } = await readUpTo(streamOf(source, 7), 101);
    expect(head.equals(source)).toBe(true);
    expect(ended).toBe(true);
  });

  it("rejects with the stream's error", async () => {
    const err = new Error("disk gone");
    const stream = streamOf(pattern(100), 10, { bytes: 30, err });
    await expect(readUpTo(stream, 101)).rejects.toBe(err);
  });
});

describe("FileServiceClient.uploadObject", () => {
  it("a Buffer of exactly the threshold uses one PUT", async () => {
    const file = pattern(10 * MiB);
    await client().uploadObject("b", "k", { file });

    expect(mockRequests.files.uploadObject).toHaveBeenCalledTimes(1);
    expect(mockRequests.files.uploadObject.mock.calls[0][2].file).toBe(file);
    expect(mockRequests.files.initiateMultipart).not.toHaveBeenCalled();
  });

  it("a Buffer one byte over the threshold goes multipart", async () => {
    const file = pattern(10 * MiB + 1);
    const result = await client().uploadObject("b", "k", { file });

    expect(result).toEqual(OBJECT);
    expect(mockRequests.files.uploadObject).not.toHaveBeenCalled();
    expect(mockRequests.files.initiateMultipart.mock.calls[0][2]).toMatchObject(
      { expectedSize: 10 * MiB + 1 }
    );
    expect(partBodies().map((b) => b.length)).toEqual([5 * MiB, 5 * MiB, 1]);
    expect(
      mockRequests.files.uploadPart.mock.calls.map((call) => call[2])
    ).toEqual([1, 2, 3]);
    expect(Buffer.concat(partBodies()).equals(file)).toBe(true);
    expect(mockRequests.files.completeMultipart).toHaveBeenCalledWith(
      "b",
      UPLOAD_ID,
      expect.objectContaining({
        parts: [
          { partNumber: 1, etag: "e1" },
          { partNumber: 2, etag: "e2" },
          { partNumber: 3, etag: "e3" },
        ],
      })
    );
    expect(mockRequests.files.abortMultipart).not.toHaveBeenCalled();
  });

  it("a stream of exactly the threshold uses one PUT", async () => {
    const source = pattern(10 * MiB);
    await client().uploadObject("b", "k", { file: streamOf(source) });

    expect(mockRequests.files.initiateMultipart).not.toHaveBeenCalled();
    expect(mockRequests.files.uploadObject).toHaveBeenCalledTimes(1);
    const sent = mockRequests.files.uploadObject.mock.calls[0][2].file;
    expect(Buffer.isBuffer(sent)).toBe(true);
    expect((sent as Buffer).equals(source)).toBe(true);
  });

  it("an empty Buffer and an empty stream use one PUT of 0 bytes", async () => {
    await client().uploadObject("b", "k", { file: Buffer.alloc(0) });
    await client().uploadObject("b", "k", { file: streamOf(Buffer.alloc(0)) });

    expect(mockRequests.files.initiateMultipart).not.toHaveBeenCalled();
    expect(mockRequests.files.uploadObject).toHaveBeenCalledTimes(2);
    for (const call of mockRequests.files.uploadObject.mock.calls) {
      expect(Buffer.isBuffer(call[2].file)).toBe(true);
      expect((call[2].file as Buffer).length).toBe(0);
    }
  });

  it("a 12 MiB stream in 64 KiB chunks goes multipart", async () => {
    const source = pattern(12 * MiB);
    await client().uploadObject("b", "k", { file: streamOf(source) });

    expect(mockRequests.files.uploadObject).not.toHaveBeenCalled();
    expect(
      mockRequests.files.initiateMultipart.mock.calls[0][2].expectedSize
    ).toBeUndefined();
    expect(partBodies().map((b) => b.length)).toEqual([
      5 * MiB,
      5 * MiB,
      2 * MiB,
    ]);
    expect(Buffer.concat(partBodies()).equals(source)).toBe(true);
    expect(mockRequests.files.completeMultipart).toHaveBeenCalledTimes(1);
  });

  it("a stream delivering one 12 MiB chunk is split into 5/5/2 MiB parts", async () => {
    const source = pattern(12 * MiB);
    await client().uploadObject("b", "k", {
      file: streamOf(source, 12 * MiB),
    });

    expect(partBodies().map((b) => b.length)).toEqual([
      5 * MiB,
      5 * MiB,
      2 * MiB,
    ]);
    expect(Buffer.concat(partBodies()).equals(source)).toBe(true);
  });

  it("a stream ending exactly on a part boundary sends no empty part", async () => {
    const source = pattern(15 * MiB);
    await client().uploadObject("b", "k", { file: streamOf(source) });

    expect(partBodies().map((b) => b.length)).toEqual([
      5 * MiB,
      5 * MiB,
      5 * MiB,
    ]);
    expect(Buffer.concat(partBodies()).equals(source)).toBe(true);
  });

  it("no more than partConcurrency parts are in flight", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    mockRequests.files.uploadPart.mockImplementation(
      async (_b: string, _u: string, n: number, input: { body: Buffer }) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const gate = deferred<void>();
        setTimeout(() => gate.resolve(), 1);
        await gate.promise;
        inFlight -= 1;
        return partResponse(n, input.body);
      }
    );

    await client().uploadObject("b", "k", { file: pattern(25 * MiB) });

    expect(mockRequests.files.uploadPart).toHaveBeenCalledTimes(5);
    expect(maxInFlight).toBe(2);
  });

  it("a failed part aborts and rethrows it", async () => {
    const err = new Error("part 2 failed");
    mockRequests.files.uploadPart.mockImplementation(
      async (_b: string, _u: string, n: number, input: { body: Buffer }) => {
        if (n === 2) throw err;
        return partResponse(n, input.body);
      }
    );

    await expect(
      client().uploadObject("b", "k", { file: pattern(12 * MiB) })
    ).rejects.toBe(err);
    expect(mockRequests.files.abortMultipart).toHaveBeenCalledTimes(1);
    expect(mockRequests.files.abortMultipart).toHaveBeenCalledWith(
      "b",
      UPLOAD_ID
    );
    expect(mockRequests.files.completeMultipart).not.toHaveBeenCalled();
  });

  it("a failed part stops new parts and aborts once in-flight parts settle", async () => {
    const err = new Error("part 1 failed");
    const part2 = deferred<void>();
    mockRequests.files.uploadPart.mockImplementation(
      async (_b: string, _u: string, n: number, input: { body: Buffer }) => {
        if (n === 1) {
          await new Promise((r) => setTimeout(r, 1));
          throw err;
        }
        await part2.promise;
        return partResponse(n, input.body);
      }
    );

    const upload = client().uploadObject("b", "k", { file: pattern(25 * MiB) });
    const settled = upload.catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 20));

    expect(mockRequests.files.uploadPart).toHaveBeenCalledTimes(2);
    expect(mockRequests.files.abortMultipart).not.toHaveBeenCalled();

    part2.resolve();
    expect(await settled).toBe(err);
    expect(mockRequests.files.uploadPart).toHaveBeenCalledTimes(2);
    expect(mockRequests.files.abortMultipart).toHaveBeenCalledTimes(1);
  });

  it("a failed part rejects even while a stream read is stalled", async () => {
    const err = new Error("part failed");
    mockRequests.files.uploadPart.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      throw err;
    });
    const stream = stallingStreamOf(pattern(20 * MiB), 11 * MiB);
    const upload = new FileServiceClient({
      multipartThresholdBytes: 10 * MiB,
      partSizeBytes: 5 * MiB,
      partConcurrency: 3,
    }).uploadObject("b", "k", { file: stream });

    const outcome = await Promise.race([
      upload.then(
        () => "resolved",
        (e: unknown) => e
      ),
      new Promise((r) => setTimeout(() => r("pending"), 1000)),
    ]);
    expect(outcome).toBe(err);
    expect(mockRequests.files.abortMultipart).toHaveBeenCalledTimes(1);
    expect(mockRequests.files.completeMultipart).not.toHaveBeenCalled();
    expect(stream.destroyed).toBe(true);
  });

  it("a malformed part response takes the failure path", async () => {
    const part2 = deferred<void>();
    mockRequests.files.uploadPart.mockImplementation(
      async (_b: string, _u: string, n: number, input: { body: Buffer }) => {
        if (n === 1) return undefined;
        await part2.promise;
        return partResponse(n, input.body);
      }
    );

    const settled = client()
      .uploadObject("b", "k", { file: pattern(12 * MiB) })
      .catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 20));

    expect(mockRequests.files.uploadPart).toHaveBeenCalledTimes(2);
    expect(mockRequests.files.abortMultipart).not.toHaveBeenCalled();

    part2.resolve();
    expect(await settled).toBeInstanceOf(TypeError);
    expect(mockRequests.files.uploadPart).toHaveBeenCalledTimes(2);
    expect(mockRequests.files.abortMultipart).toHaveBeenCalledTimes(1);
    expect(mockRequests.files.completeMultipart).not.toHaveBeenCalled();
  });

  it("a stream source is read only when a part slot is free", async () => {
    const source = pattern(30 * MiB);
    let delivered = 0;
    const stream = new Readable({
      read() {
        if (delivered >= source.length) {
          this.push(null);
          return;
        }
        this.push(source.subarray(delivered, delivered + 64 * 1024));
        delivered += 64 * 1024;
      },
    });
    const gates: (() => void)[] = [];
    mockRequests.files.uploadPart.mockImplementation(
      async (_b: string, _u: string, n: number, input: { body: Buffer }) => {
        await new Promise<void>((r) => gates.push(r));
        return partResponse(n, input.body);
      }
    );
    const tick = () => new Promise((r) => setTimeout(r, 10));

    const upload = client().uploadObject("b", "k", { file: stream });
    await tick();
    // Parts 1 and 2 come from the 10 MiB + 1 head; with both slots busy the
    // stream gives no more than its own small read-ahead.
    expect(mockRequests.files.uploadPart).toHaveBeenCalledTimes(2);
    expect(delivered).toBeLessThan(10 * MiB + 1 + 512 * 1024);

    gates.shift()!();
    await tick();
    expect(mockRequests.files.uploadPart).toHaveBeenCalledTimes(3);
    expect(delivered).toBeGreaterThanOrEqual(15 * MiB);
    expect(delivered).toBeLessThan(15 * MiB + 512 * 1024);

    while (
      mockRequests.files.uploadPart.mock.calls.length < 6 ||
      gates.length
    ) {
      gates.shift()?.();
      await tick();
    }
    await upload;
    expect(Buffer.concat(partBodies()).equals(source)).toBe(true);
  });

  it("parts cut from the head do not share its allocation", async () => {
    await client().uploadObject("b", "k", {
      file: streamOf(pattern(12 * MiB), 12 * MiB),
    });
    const [p1, p2] = partBodies();
    expect(p1.buffer).not.toBe(p2.buffer);
    expect(p1.byteLength).toBe(p1.buffer.byteLength);
  });

  it("a failed initiate rethrows without aborting", async () => {
    const err = new Error("initiate failed");
    mockRequests.files.initiateMultipart.mockRejectedValue(err);

    await expect(
      client().uploadObject("b", "k", { file: pattern(12 * MiB) })
    ).rejects.toBe(err);
    expect(mockRequests.files.uploadPart).not.toHaveBeenCalled();
    expect(mockRequests.files.abortMultipart).not.toHaveBeenCalled();
  });

  it("a failed abort does not mask the original error", async () => {
    const err = new Error("part failed");
    const abortErr = new Error("abort failed");
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    mockRequests.files.uploadPart.mockRejectedValue(err);
    mockRequests.files.abortMultipart.mockRejectedValue(abortErr);

    await expect(
      client().uploadObject("b", "k", { file: pattern(12 * MiB) })
    ).rejects.toBe(err);
    expect(mockRequests.files.abortMultipart).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: abortErr,
        bucket: "b",
        uploadId: UPLOAD_ID,
      }),
      expect.any(String)
    );
  });

  it("a 412 at complete aborts and rethrows", async () => {
    const err = Object.assign(new Error("precondition failed"), {
      originalStatus: 412,
    });
    mockRequests.files.completeMultipart.mockRejectedValue(err);

    await expect(
      client().uploadObject("b", "k", {
        file: pattern(12 * MiB),
        ifMatch: '"abc"',
      })
    ).rejects.toBe(err);
    expect(mockRequests.files.abortMultipart).toHaveBeenCalledWith(
      "b",
      UPLOAD_ID
    );
  });

  it("a stream error aborts and rethrows", async () => {
    const err = new Error("source failed");
    const stream = streamOf(pattern(20 * MiB), 64 * 1024, {
      bytes: 13 * MiB,
      err,
    });

    await expect(
      client().uploadObject("b", "k", { file: stream })
    ).rejects.toBe(err);
    expect(mockRequests.files.initiateMultipart).toHaveBeenCalledTimes(1);
    expect(mockRequests.files.abortMultipart).toHaveBeenCalledWith(
      "b",
      UPLOAD_ID
    );
    expect(mockRequests.files.completeMultipart).not.toHaveBeenCalled();
  });

  it("a stream error between readUpTo and uploadMultipart is not lost", async () => {
    const err = new Error("source failed");
    const stream = streamOf(pattern(12 * MiB));
    const { head, ended } = await readUpTo(stream, 10 * MiB + 1);
    expect(ended).toBe(false);

    stream.destroy(err);
    await new Promise((r) => setImmediate(r));

    await expect(
      uploadMultipart(
        "b",
        "k",
        { head, rest: stream },
        {},
        resolveUploadOptions({ partSizeBytes: 5 * MiB })
      )
    ).rejects.toBe(err);
    expect(mockRequests.files.abortMultipart).toHaveBeenCalledWith(
      "b",
      UPLOAD_ID
    );
  });

  it("a failed part destroys the source stream", async () => {
    const err = new Error("part failed");
    mockRequests.files.uploadPart.mockRejectedValue(err);
    const stream = streamOf(pattern(20 * MiB));

    await expect(
      client().uploadObject("b", "k", { file: stream })
    ).rejects.toBe(err);
    expect(stream.destroyed).toBe(true);
  });

  it("a stream error before the threshold rethrows without a request", async () => {
    const err = new Error("source failed");
    const stream = streamOf(pattern(20 * MiB), 64 * 1024, {
      bytes: 1 * MiB,
      err,
    });

    await expect(
      client().uploadObject("b", "k", { file: stream })
    ).rejects.toBe(err);
    expect(mockRequests.files.uploadObject).not.toHaveBeenCalled();
    expect(mockRequests.files.initiateMultipart).not.toHaveBeenCalled();
  });

  it("preconditions, metadata, tags and idempotencyKey are forwarded", async () => {
    await client().uploadObject("b", "k", {
      file: pattern(12 * MiB),
      ifMatch: '"abc"',
      idempotencyKey: "k1",
      metadata: { a: 1 },
      tags: ["t1"],
    });

    expect(mockRequests.files.initiateMultipart).toHaveBeenCalledWith(
      "b",
      "k",
      expect.objectContaining({
        contentType: "application/octet-stream",
        metadata: { a: 1 },
        tags: ["t1"],
        ifMatch: '"abc"',
      })
    );
    expect(mockRequests.files.completeMultipart).toHaveBeenCalledWith(
      "b",
      UPLOAD_ID,
      expect.objectContaining({ idempotencyKey: "k1", ifMatch: '"abc"' })
    );
  });

  it("forwards If-None-Match and an explicit content type", async () => {
    await client().uploadObject("b", "k", {
      file: pattern(12 * MiB),
      ifNoneMatch: "*",
      contentType: "video/mp4",
    });

    expect(mockRequests.files.initiateMultipart).toHaveBeenCalledWith(
      "b",
      "k",
      expect.objectContaining({ contentType: "video/mp4", ifNoneMatch: "*" })
    );
    expect(mockRequests.files.completeMultipart).toHaveBeenCalledWith(
      "b",
      UPLOAD_ID,
      expect.objectContaining({ ifNoneMatch: "*" })
    );
  });

  it("multipart success invalidates the object's cache entry", async () => {
    mockRedis.store.set("file-sdk:v1:object:b/k", JSON.stringify({ a: 1 }));
    await client().uploadObject("b", "k", { file: pattern(12 * MiB) });
    expect(mockRedis.store.has("file-sdk:v1:object:b/k")).toBe(false);
  });

  it("testMode drains a stream and returns the mock object", async () => {
    const stream = streamOf(pattern(1000), 100);
    const testClient = new FileServiceClient(undefined, true);

    const result = await testClient.uploadObject("b", "k", { file: stream });

    expect(result).toMatchObject({ key: "k", sizeBytes: "1000" });
    expect(stream.readableEnded).toBe(true);
    expect(mockRequests.files.uploadObject).not.toHaveBeenCalled();
    expect(mockRequests.files.initiateMultipart).not.toHaveBeenCalled();
  });
});
