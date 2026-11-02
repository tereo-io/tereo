import { requests } from "../handler.js";
import type { Readable } from "stream";
import { logger } from "./logger.js";
import type {
  FileServiceClientConfig,
  FileServiceObject,
  UploadObjectInput,
} from "../types/files.js";

export const MIN_PART_SIZE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MULTIPART_THRESHOLD_BYTES = 64 * 1024 * 1024;
export const DEFAULT_PART_SIZE_BYTES = 16 * 1024 * 1024;
export const DEFAULT_PART_CONCURRENCY = 4;

export interface UploadOptions {
  thresholdBytes: number;
  partSizeBytes: number;
  partConcurrency: number;
}

export const resolveUploadOptions = (
  config?: FileServiceClientConfig
): UploadOptions => {
  const thresholdBytes =
    config?.multipartThresholdBytes ?? DEFAULT_MULTIPART_THRESHOLD_BYTES;
  const partSizeBytes = config?.partSizeBytes ?? DEFAULT_PART_SIZE_BYTES;
  const partConcurrency = config?.partConcurrency ?? DEFAULT_PART_CONCURRENCY;

  if (!Number.isInteger(partSizeBytes) || partSizeBytes < MIN_PART_SIZE_BYTES) {
    throw new Error(
      `@tereo-io/sdk: partSizeBytes must be an integer of at least ${MIN_PART_SIZE_BYTES} (5 MiB)`
    );
  }
  if (!Number.isInteger(thresholdBytes) || thresholdBytes < partSizeBytes) {
    throw new Error(
      `@tereo-io/sdk: multipartThresholdBytes must be an integer of at least partSizeBytes (${partSizeBytes})`
    );
  }
  if (!Number.isInteger(partConcurrency) || partConcurrency < 1) {
    throw new Error(
      "@tereo-io/sdk: partConcurrency must be an integer of at least 1"
    );
  }
  return { thresholdBytes, partSizeBytes, partConcurrency };
};

const EMPTY = Buffer.alloc(0);

/**
 * Stands in for a consumer between `readUpTo` returning and `uploadMultipart`
 * attaching its own listener, so an error emitted in that gap is not thrown
 * as unhandled. The stream keeps it in `errored`, which `StreamReader` checks.
 */
const parkError = (): void => {};

const toBuffer = (chunk: unknown): Buffer =>
  Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);

/** Reads exact byte counts from a paused stream, holding its `error` listener. */
class StreamReader {
  private error: { err: unknown } | undefined;
  private ended: boolean;
  private wake: (() => void) | undefined;

  constructor(private readonly stream: Readable) {
    this.ended = stream.readableEnded;
    if (stream.errored) this.error = { err: stream.errored };
    else if (stream.destroyed && !this.ended) this.onClose();
    stream.on("error", this.onError);
    stream.on("end", this.onEnd);
    stream.on("close", this.onClose);
    stream.on("readable", this.onSignal);
    stream.off("error", parkError);
  }

  /** Up to `size` bytes; fewer only when the stream has ended. */
  async read(size: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let length = 0;
    while (length < size) {
      if (this.error) throw this.error.err;
      const chunk: unknown = this.stream.read();
      if (chunk === null) {
        if (this.ended) break;
        await new Promise<void>((resolve) => (this.wake = resolve));
        continue;
      }
      const buf = toBuffer(chunk);
      const room = size - length;
      if (buf.length > room) {
        chunks.push(buf.subarray(0, room));
        this.stream.unshift(buf.subarray(room));
        length = size;
      } else {
        chunks.push(buf);
        length += buf.length;
      }
    }
    return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, length);
  }

  dispose(): void {
    this.stream.off("error", this.onError);
    this.stream.off("end", this.onEnd);
    this.stream.off("close", this.onClose);
    this.stream.off("readable", this.onSignal);
  }

  private onError = (err: unknown): void => {
    this.error ??= { err };
    this.onSignal();
  };

  private onEnd = (): void => {
    this.ended = true;
    this.onSignal();
  };

  private onClose = (): void => {
    if (!this.ended) {
      this.error ??= {
        err: new Error("@tereo-io/sdk: upload stream closed before it ended"),
      };
    }
    this.onSignal();
  };

  private onSignal = (): void => {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  };
}

/**
 * Collects up to `limit` bytes from `stream`. `ended` is true when the stream
 * finished within them; otherwise the unread data stays readable from it.
 */
export const readUpTo = async (
  stream: Readable,
  limit: number
): Promise<{ head: Buffer; ended: boolean }> => {
  const reader = new StreamReader(stream);
  try {
    const head = await reader.read(limit);
    const ended = head.length < limit;
    if (!ended) stream.on("error", parkError);
    return { head, ended };
  } finally {
    reader.dispose();
  }
};

type MultipartSource = { buffer: Buffer } | { head: Buffer; rest: Readable };

/** Yields the next part's bytes, or null when the source is exhausted. */
const partSource = (
  source: MultipartSource,
  partSize: number,
  reader: StreamReader | undefined
): (() => Promise<Buffer | null>) => {
  if ("buffer" in source) {
    let offset = 0;
    return async () => {
      if (offset >= source.buffer.length) return null;
      const part = source.buffer.subarray(offset, offset + partSize);
      offset += part.length;
      return part;
    };
  }
  let head = source.head;
  return async () => {
    if (head.length >= partSize) {
      const part = head.subarray(0, partSize);
      head = head.subarray(partSize);
      return part;
    }
    const more = await reader!.read(partSize - head.length);
    const part = head.length > 0 ? Buffer.concat([head, more]) : more;
    head = EMPTY;
    return part.length > 0 ? part : null;
  };
};

const uploadParts = async (
  bucket: string,
  uploadId: string,
  nextPart: () => Promise<Buffer | null>,
  partConcurrency: number
): Promise<{ partNumber: number; etag: string }[]> => {
  const uploaded: { partNumber: number; etag: string }[] = [];
  const inFlight = new Set<Promise<void>>();
  let failure: { err: unknown } | undefined;
  let partNumber = 0;

  while (!failure) {
    // The source is read only once a slot is free, so at most
    // `partConcurrency` parts are held in memory.
    if (inFlight.size >= partConcurrency) {
      await Promise.race(inFlight);
      continue;
    }
    let body: Buffer | null;
    try {
      body = await nextPart();
    } catch (err) {
      failure ??= { err };
      break;
    }
    if (!body) break;
    const n = ++partNumber;
    const pending: Promise<void> = requests.files
      .uploadPart(bucket, uploadId, n, { body })
      .then(
        (res) => {
          uploaded.push({ partNumber: n, etag: res.etag });
        },
        (err: unknown) => {
          failure ??= { err };
        }
      )
      .finally(() => inFlight.delete(pending));
    inFlight.add(pending);
  }

  await Promise.all(inFlight);
  if (failure) throw failure.err;
  return uploaded.sort((a, b) => a.partNumber - b.partNumber);
};

const abortQuietly = async (bucket: string, uploadId: string) => {
  try {
    await requests.files.abortMultipart(bucket, uploadId);
  } catch (err) {
    logger.warn(
      { err, bucket, uploadId },
      "Failed to abort multipart upload after an error"
    );
  }
};

/**
 * Initiates, uploads the parts `partConcurrency` at a time and completes. Any
 * failure after initiate aborts the upload and rethrows the first error.
 */
export const uploadMultipart = async (
  bucket: string,
  key: string,
  source: MultipartSource,
  input: Omit<UploadObjectInput, "file">,
  options: UploadOptions
): Promise<FileServiceObject> => {
  // Attached before the first await, so a stream error during initiate is held.
  const reader = "rest" in source ? new StreamReader(source.rest) : undefined;
  try {
    const { uploadId } = await requests.files.initiateMultipart(bucket, key, {
      contentType: input.contentType ?? "application/octet-stream",
      metadata: input.metadata,
      tags: input.tags,
      expectedSize: "buffer" in source ? source.buffer.length : undefined,
      ifMatch: input.ifMatch,
      ifNoneMatch: input.ifNoneMatch,
    });
    try {
      const parts = await uploadParts(
        bucket,
        uploadId,
        partSource(source, options.partSizeBytes, reader),
        options.partConcurrency
      );
      return await requests.files.completeMultipart(bucket, uploadId, {
        parts,
        idempotencyKey: input.idempotencyKey,
        ifMatch: input.ifMatch,
        ifNoneMatch: input.ifNoneMatch,
      });
    } catch (err) {
      await abortQuietly(bucket, uploadId);
      throw err;
    }
  } catch (err) {
    // Releases the source (a file descriptor, a socket) the upload gave up on.
    if ("rest" in source) source.rest.destroy();
    throw err;
  } finally {
    reader?.dispose();
  }
};
