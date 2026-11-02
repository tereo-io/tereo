import type { CompleteMultipartInput } from "../requests/files/multipart/types.js";
import { RequestError } from "./errors.js";
import { requests } from "../handler.js";
import type { Readable } from "stream";
import { logger } from "./logger.js";
import { v7 as uuidv7 } from "uuid";
import type {
  FileServiceClientConfig,
  FileServiceObject,
  UploadObjectInput,
} from "../types/files.js";

export const MIN_PART_SIZE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MULTIPART_THRESHOLD_BYTES = 64 * 1024 * 1024;
export const DEFAULT_PART_SIZE_BYTES = 16 * 1024 * 1024;
export const DEFAULT_PART_CONCURRENCY = 4;

/**
 * How long a complete answered `409 multipart_complete_in_progress` is
 * retried: as long as one upload request may take.
 */
export const COMPLETE_IN_PROGRESS_MAX_WAIT_MS = 10 * 60 * 1000;
const COMPLETE_RETRY_INITIAL_DELAY_MS = 1000;
const COMPLETE_RETRY_MAX_DELAY_MS = 30 * 1000;

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

  /** Fails the pending and every later `read` with `err`. */
  fail(err: unknown): void {
    this.error ??= { err };
    this.onSignal();
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
 * finished within them; otherwise the unread data stays readable from it, and
 * its errors are held until a `StreamReader` takes it over, so the caller must
 * hand it to `uploadMultipart` (or destroy it).
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

type NextPart = () => Promise<Buffer | null>;

const bufferParts = (buffer: Buffer, partSize: number): NextPart => {
  let offset = 0;
  return async () => {
    if (offset >= buffer.length) return null;
    const part = buffer.subarray(offset, offset + partSize);
    offset += part.length;
    return part;
  };
};

/**
 * Parts from `head`, then from the reader. Head bytes are copied into each
 * part and `head` is dropped once used up, so an uploaded part does not keep
 * the whole head's allocation alive.
 */
const streamParts = (
  initialHead: Buffer,
  reader: StreamReader,
  partSize: number
): NextPart => {
  let head: Buffer | undefined = initialHead;
  return async () => {
    if (head && head.length >= partSize) {
      const part = Buffer.from(head.subarray(0, partSize));
      head = head.length > partSize ? head.subarray(partSize) : undefined;
      return part;
    }
    const rest = head;
    head = undefined;
    const more = await reader.read(partSize - (rest?.length ?? 0));
    const part = rest ? Buffer.concat([rest, more]) : more;
    return part.length > 0 ? part : null;
  };
};

const uploadParts = async (
  bucket: string,
  uploadId: string,
  nextPart: NextPart,
  partConcurrency: number,
  reader: StreamReader | undefined
): Promise<{ partNumber: number; etag: string }[]> => {
  const uploaded: { partNumber: number; etag: string }[] = [];
  const inFlight = new Set<Promise<void>>();
  let failure: { err: unknown } | undefined;
  let partNumber = 0;

  const fail = (err: unknown) => {
    failure ??= { err };
    // Wakes a read parked on a stalled source, which would otherwise keep
    // the loop from ever seeing the failure.
    reader?.fail(failure.err);
  };

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
      fail(err);
      break;
    }
    if (!body || failure) break;
    const n = ++partNumber;
    const part = body;
    const pending: Promise<void> = Promise.resolve()
      .then(() =>
        requests.files.uploadPart(bucket, uploadId, n, { body: part })
      )
      .then((res) => {
        uploaded.push({ partNumber: n, etag: res.etag });
      })
      .catch(fail)
      .finally(() => inFlight.delete(pending));
    inFlight.add(pending);
  }

  await Promise.all(inFlight);
  if (failure) throw failure.err;
  return uploaded.sort((a, b) => a.partNumber - b.partNumber);
};

const isCompleteInProgress = (err: unknown): boolean =>
  err instanceof RequestError &&
  err.httpStatus === 409 &&
  err.coreCode === "multipart_complete_in_progress";

/**
 * Completes, retrying while core reports an earlier attempt still assembling
 * (a transport retry after a dropped connection lands on its claim), until
 * that attempt's stored result comes back as a replay.
 */
const completeWhenSettled = async (
  bucket: string,
  uploadId: string,
  input: CompleteMultipartInput
): Promise<FileServiceObject> => {
  const deadline = Date.now() + COMPLETE_IN_PROGRESS_MAX_WAIT_MS;
  let delay = COMPLETE_RETRY_INITIAL_DELAY_MS;
  for (;;) {
    try {
      return await requests.files.completeMultipart(bucket, uploadId, input);
    } catch (err) {
      const remaining = deadline - Date.now();
      if (!isCompleteInProgress(err) || remaining <= 0) throw err;
      const wait = Math.min(delay, remaining);
      await new Promise((resolve) => setTimeout(resolve, wait));
      delay = Math.min(delay * 2, COMPLETE_RETRY_MAX_DELAY_MS);
    }
  }
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
export const uploadMultipart = (
  bucket: string,
  key: string,
  source: MultipartSource,
  input: Omit<UploadObjectInput, "file">,
  options: UploadOptions
): Promise<FileServiceObject> => {
  // Not async: `source` stays in this frame only, so the upload does not
  // hold the stream's head past the parts cut from it. The reader is
  // attached here, before any await, so a stream error during initiate is held.
  if ("buffer" in source) {
    return runMultipart(bucket, key, input, options, {
      nextPart: bufferParts(source.buffer, options.partSizeBytes),
      expectedSize: source.buffer.length,
    });
  }
  const reader = new StreamReader(source.rest);
  return runMultipart(bucket, key, input, options, {
    nextPart: streamParts(source.head, reader, options.partSizeBytes),
    stream: { rest: source.rest, reader },
  });
};

const runMultipart = async (
  bucket: string,
  key: string,
  input: Omit<UploadObjectInput, "file">,
  options: UploadOptions,
  parts: {
    nextPart: NextPart;
    expectedSize?: number;
    stream?: { rest: Readable; reader: StreamReader };
  }
): Promise<FileServiceObject> => {
  const { nextPart, expectedSize, stream } = parts;
  // One key for every attempt at complete, so a retry replays the first.
  const idempotencyKey = input.idempotencyKey ?? uuidv7();
  try {
    const { uploadId } = await requests.files.initiateMultipart(bucket, key, {
      contentType: input.contentType ?? "application/octet-stream",
      metadata: input.metadata,
      tags: input.tags,
      expectedSize,
      ifMatch: input.ifMatch,
      ifNoneMatch: input.ifNoneMatch,
    });
    try {
      const uploaded = await uploadParts(
        bucket,
        uploadId,
        nextPart,
        options.partConcurrency,
        stream?.reader
      );
      return await completeWhenSettled(bucket, uploadId, {
        parts: uploaded,
        idempotencyKey,
        ifMatch: input.ifMatch,
        ifNoneMatch: input.ifNoneMatch,
      });
    } catch (err) {
      await abortQuietly(bucket, uploadId);
      throw err;
    }
  } catch (err) {
    // Releases the source (a file descriptor, a socket) the upload gave up on.
    stream?.rest.destroy();
    throw err;
  } finally {
    stream?.reader.dispose();
  }
};
