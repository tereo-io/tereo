import type { ObjectForArchiveStream } from "./db/archives.js";
import { Archiver, TarArchive, ZipArchive } from "archiver";
import { openBlobStream } from "./storage.js";
import type { Readable } from "stream";
import { logger } from "./logger.js";

export type ArchiveFormat = "zip" | "tar";

export interface BuildArchiveInput {
  objects: ObjectForArchiveStream[];
  format: ArchiveFormat;
  /** When set, strip this prefix from each object's entry name so the archive
   * extracts into a clean top-level folder instead of reproducing the bucket
   * path. Applied only if the object's key actually starts with the prefix. */
  stripPrefix?: string | null;
}

export interface BuildArchiveResult {
  stream: Archiver;
  /** Resolves when archive finalization finishes (or rejects on a fatal error
   * — per-entry errors do not reject; they're recorded in the manifest — and
   * with `ArchiveAbortedError` after `abort`). */
  finalized: Promise<void>;
  /** Stops building: closes the entry being read and aborts the archive. For
   * a client that went away mid-download. */
  abort: () => void;
}

export class ArchiveAbortedError extends Error {
  constructor() {
    super("Archive aborted");
    this.name = "ArchiveAbortedError";
  }
}

const MANIFEST_FILENAME = "MISSING_FILES.txt";

/**
 * Build a streaming zip/tar from pre-loaded object metadata. Each entry's
 * plaintext is produced by `openBlobStream()` — archiver consumes that stream
 * and appends the entry. Per-entry read/decrypt failures are caught and logged
 * to a trailing manifest rather than aborting the whole archive, so a single
 * corrupt blob doesn't take the rest of the download with it.
 *
 * Entries are opened one at a time, each once the one before it has been read
 * to the end, so an archive holds one blob file open at a time rather than
 * one per object.
 *
 * The returned `stream` is ready to pipe directly to the HTTP response.
 */
export function buildArchiveStream(
  input: BuildArchiveInput
): BuildArchiveResult {
  const archive: Archiver =
    input.format === "tar"
      ? new TarArchive()
      : new ZipArchive({ zlib: { level: 6 } });

  const missing: Array<{ objectKey: string; reason: string }> = [];

  let stopped = false;
  let failure: Error | null = null;
  let current: Readable | null = null;
  let wake: (() => void) | null = null;
  // Archiver errors are fatal to the archive (the route resets the response):
  // stop opening entries.
  archive.on("error", (err) => {
    failure ??= err;
    stopped = true;
    wake?.();
  });
  let aborted = false;
  const abort = () => {
    if (aborted) return;
    aborted = stopped = true;
    current?.destroy();
    archive.abort();
    wake?.();
  };

  /** Resolves once `entry` closes: read to the end, failed, or destroyed. */
  const consumed = (entry: Readable) =>
    new Promise<void>((resolve) => {
      const done = () => {
        entry.off("close", done);
        wake = null;
        resolve();
      };
      wake = done;
      entry.on("close", done);
    });

  const finalized = (async () => {
    for (const obj of input.objects) {
      if (stopped) break;
      const entryName = entryNameFor(obj.objectKey, input.stripPrefix);
      try {
        const entryStream = openBlobStream(
          {
            fsPath: obj.contentBlob.fsPath,
            keyMaterial: {
              wrappedDek: Buffer.from(obj.contentBlob.wrappedDek),
              iv: Buffer.from(obj.contentBlob.iv),
              masterKeyVersion: obj.contentBlob.masterKeyVersion,
            },
          },
          obj.contentBlob.hash
        );
        // A per-entry error event here would otherwise crash the process —
        // archiver forwards entry errors to its own error handler, but we
        // also want to capture the key in the manifest.
        entryStream.on("error", (err) => {
          logger.warn(
            {
              objectKey: obj.objectKey,
              err,
            },
            "Archive entry stream error"
          );
          missing.push({ objectKey: obj.objectKey, reason: err.message });
        });
        current = entryStream;
        archive.append(entryStream, { name: entryName });
        await consumed(entryStream);
        current = null;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(
          {
            objectKey: obj.objectKey,
            err,
          },
          "Failed to open blob for archive entry"
        );
        missing.push({ objectKey: obj.objectKey, reason: message });
      }
    }

    if (aborted) throw new ArchiveAbortedError();
    if (failure) throw failure;

    if (missing.length > 0) {
      const body =
        "The following files were listed in the archive request but could not be included:\n\n" +
        missing.map((m) => `${m.objectKey}\t${m.reason}`).join("\n") +
        "\n";
      archive.append(Buffer.from(body, "utf8"), { name: MANIFEST_FILENAME });
    }

    await archive.finalize();
  })();

  return { stream: archive, finalized, abort };
}

function entryNameFor(
  objectKey: string,
  stripPrefix: string | null | undefined
): string {
  if (stripPrefix && objectKey.startsWith(stripPrefix)) {
    const stripped = objectKey.slice(stripPrefix.length);
    // Never emit an empty or absolute-looking entry name.
    return stripped.length > 0 ? stripped.replace(/^\/+/, "") : objectKey;
  }
  return objectKey;
}
