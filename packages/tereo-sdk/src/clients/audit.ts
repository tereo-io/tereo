import { validateEntry } from "../utils/auditSchemas.js";
import { computeChanges } from "../utils/audit.js";
import { logger } from "../utils/logger.js";
import { requests } from "../handler.js";
import { v7 as uuidv7 } from "uuid";
import type {
  AuditLogBatchResult,
  AuditLogEntityQueryOptions,
  AuditLogEntryInput,
  AuditLogQueryOptions,
  AuditLogQueryResult,
  AuditLogReadResult,
  AuditLogResult,
  AuditLogServiceClientConfig,
  QueryByEntityOrMetadataOptions,
} from "../types/audit.js";
import type {
  AuditLogListEntriesParams,
  CreateEntryInput,
} from "../handler.js";

/** What orders an entry: `createdAt`, then `id`. */
interface EntryKey {
  createdAt: string;
  id: string;
}

/**
 * Where one stream of `queryByEntityOrMetadata` resumes: the core cursor of
 * the page to fetch (absent for the first page) and the last of that page's
 * entries already returned. `done` once the stream is exhausted.
 */
interface StreamPosition {
  cursor?: string;
  after?: EntryKey;
  done?: boolean;
}

interface CompositeCursor {
  entity: StreamPosition;
  meta: StreamPosition;
}

const INVALID_CURSOR = "Invalid queryByEntityOrMetadata cursor";

// Plain base64: the inner cursors are already HMAC-signed by core.
const encodeCompositeCursor = (parts: CompositeCursor): string =>
  Buffer.from(JSON.stringify(parts), "utf8").toString("base64url");

const parsePosition = (value: unknown): StreamPosition => {
  const p = value as StreamPosition | null;
  const after = p?.after as Partial<EntryKey> | undefined;
  if (
    !p ||
    typeof p !== "object" ||
    (p.cursor !== undefined && typeof p.cursor !== "string") ||
    (after !== undefined &&
      (typeof after?.createdAt !== "string" || typeof after?.id !== "string"))
  ) {
    throw new Error(INVALID_CURSOR);
  }
  if (p.done === true) return { done: true };
  return {
    ...(p.cursor !== undefined && { cursor: p.cursor }),
    ...(after && { after: { createdAt: after.createdAt!, id: after.id! } }),
  };
};

const decodeCompositeCursor = (raw: string): CompositeCursor => {
  let parsed: { entity?: unknown; meta?: unknown } | null;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new Error(INVALID_CURSOR);
  }
  return {
    entity: parsePosition(parsed?.entity),
    meta: parsePosition(parsed?.meta),
  };
};

const EMPTY_PAGE: AuditLogQueryResult = {
  data: [],
  hasMore: false,
  limit: 0,
  nextCursor: null,
};

export class AuditLogServiceClient {
  private readonly source: string;
  private initialized = false;

  constructor(config: AuditLogServiceClientConfig) {
    this.source = config.source;
  }

  /**
   * A client whose methods do nothing and return empty results, for a service
   * that runs without core's audit log, so its call sites don't have to branch.
   */
  static noop(): AuditLogServiceClient {
    const client = new AuditLogServiceClient({ source: "noop" });
    client.init = async () => {};
    client.log = () => {};
    client.logAsync = async () =>
      ({
        id: "",
        source: "",
        organizationId: null,
        userId: "",
        userEmail: null,
        action: "CREATE",
        entityType: "",
        entityId: "",
        entityName: null,
        changes: null,
        metadata: null,
        ipAddress: null,
        correlationId: null,
        writerUserId: "",
        createdAt: "",
      }) as AuditLogResult;
    client.logBatch = () => {};
    client.logBatchAsync = async () => ({ created: 0 });
    client.query = async () => ({
      data: [],
      hasMore: false,
      limit: 0,
      nextCursor: null,
    });
    client.getByEntity = async () => ({
      data: [],
      hasMore: false,
      limit: 0,
      nextCursor: null,
    });
    client.queryByEntityOrMetadata = async () => ({
      data: [],
      hasMore: false,
      limit: 0,
      nextCursor: null,
    });
    client.getById = async () => {
      const actor = { id: "", email: "", name: null };
      return {
        id: "",
        source: "",
        organizationId: null,
        userId: "",
        userEmail: null,
        action: "CREATE",
        entityType: "",
        entityId: "",
        entityName: null,
        changes: null,
        metadata: null,
        ipAddress: null,
        correlationId: null,
        writerUserId: "",
        createdAt: "",
        user: actor,
        writer: actor,
        organization: null,
      };
    };
    client.close = async () => {};
    client.isReady = () => false;
    client.initialized = false;
    return client;
  }

  /**
   * Field-level diff utility for the `changes` field.
   * Skips `createdAt`, `updatedAt`, `deletedAt`, `archivedAt`. Returns `undefined` if no diff.
   */
  static computeChanges(
    oldObj: Record<string, unknown>,
    newObj: Record<string, unknown>
  ): Record<string, { old: unknown; new: unknown }> | undefined {
    return computeChanges(oldObj, newObj);
  }

  isReady(): boolean {
    return this.initialized;
  }

  /**
   * Marks the client ready. Idempotent. Reliable delivery is owned by the
   * caller's transactional outbox — this SDK only provides direct HTTP
   * dispatch (`logAsync`) plus best-effort `log()` wrappers.
   */
  async init(): Promise<void> {
    this.initialized = true;
  }

  async close(): Promise<void> {
    this.initialized = false;
  }

  // ===========================================================================
  // Write methods
  // ===========================================================================

  /**
   * Best-effort fire-and-forget audit log entry — calls `logAsync` and
   * swallows any failure. For at-least-once delivery, publish through the
   * outbox (`core.outbox`) instead; its reaper calls `logAsync` directly.
   */
  log(entry: AuditLogEntryInput): void {
    try {
      validateEntry(entry);
    } catch (err) {
      logger.error(
        {
          entityType: entry.entityType,
          entityId: entry.entityId,
          err,
        },
        "Invalid audit log entry"
      );
      return;
    }

    this.logAsync(entry).catch((err) => {
      logger.error(
        {
          entityType: entry.entityType,
          entityId: entry.entityId,
          err,
        },
        "Failed to log audit entry"
      );
    });
  }

  /**
   * Direct synchronous audit log entry. Throws on failure. Without an
   * `idempotencyKey`, one is generated, so the handler's retries of this call
   * write one entry.
   */
  async logAsync(entry: AuditLogEntryInput): Promise<AuditLogResult> {
    validateEntry(entry);
    return await requests.audit.createEntry({
      ...this.toPayload(entry),
      idempotencyKey: entry.idempotencyKey ?? uuidv7(),
    });
  }

  /**
   * Best-effort batch audit log entries — calls `logBatchAsync` and swallows
   * any failure. For at-least-once delivery, publish through the
   * outbox (`core.outbox`) instead.
   */
  logBatch(entries: AuditLogEntryInput[]): void {
    if (entries.length === 0) return;

    if (entries.length > 1000) {
      logger.error(
        {
          count: entries.length,
          source: this.source,
        },
        "Batch size exceeds maximum of 1000 entries"
      );
      return;
    }

    const validEntries: AuditLogEntryInput[] = [];
    for (const entry of entries) {
      try {
        validateEntry(entry);
        validEntries.push(entry);
      } catch (err) {
        logger.error(
          {
            entityType: entry.entityType,
            entityId: entry.entityId,
            err,
          },
          "Invalid audit log entry in batch, skipping"
        );
      }
    }

    if (validEntries.length === 0) return;

    this.logBatchAsync(validEntries).catch((err) => {
      logger.error(
        {
          count: validEntries.length,
          err,
        },
        "Failed to log audit entry batch"
      );
    });
  }

  /** Direct synchronous batch audit log. Throws on failure. */
  async logBatchAsync(
    entries: AuditLogEntryInput[]
  ): Promise<AuditLogBatchResult> {
    if (entries.length > 1000) {
      throw new Error("Batch size exceeds maximum of 1000 entries");
    }

    for (const entry of entries) {
      validateEntry(entry);
    }

    // Core refuses unknown fields on batch entries; a batch has no per-entry
    // key, only one for the batch, so the handler's retries write it once.
    return await requests.audit.createBatch({
      entries: entries.map(({ idempotencyKey: _key, ...e }) =>
        this.toPayload(e)
      ),
      idempotencyKey: uuidv7(),
    });
  }

  // ===========================================================================
  // Read methods
  // ===========================================================================

  /**
   * Query audit log entries. Results are automatically scoped to this client's
   * `source` — callers cannot accidentally read another service's entries.
   */
  async query(options?: AuditLogQueryOptions): Promise<AuditLogQueryResult> {
    return await requests.audit.listEntries(this.buildListParams(options));
  }

  /**
   * Get audit log entries for a specific entity type and ID, scoped to this
   * client's `source` like `query()`.
   */
  async getByEntity(
    entityType: string,
    entityId: string,
    options?: AuditLogEntityQueryOptions
  ): Promise<AuditLogQueryResult> {
    return await requests.audit.getEntriesByEntity(entityType, entityId, {
      "filter[source]": this.source,
      ...(options?.limit != null && { limit: options.limit }),
      ...(options?.cursor && { cursor: options.cursor }),
      ...(options?.sort && { sort: options.sort }),
      ...(options?.sortDir && { sortDir: options.sortDir }),
      ...(options?.organizationId && {
        "filter[organizationId]": options.organizationId,
      }),
    });
  }

  /** Get a single audit log entry by ID. */
  async getById(id: string): Promise<AuditLogReadResult> {
    return await requests.audit.getEntry(id);
  }

  /**
   * Query entries that belong to a parent record either directly (entityId
   * matches) or by metadata reference (e.g., metadata.orderId for line-level
   * entries on an order). Pages through both queries in parallel, dedupes,
   * and merges them in core's order (`createdAt`, then `id`) behind one
   * composite cursor. A page ends early where one query's fetched entries
   * run out while core has more of them, so no entry is skipped or repeated
   * across pages.
   *
   * Used by service proxies that expose unified audit history for a parent
   * (orders, purchase orders, transfer orders, cycle counts, etc.).
   */
  async queryByEntityOrMetadata(
    opts: QueryByEntityOrMetadataOptions
  ): Promise<AuditLogQueryResult> {
    const limit = opts.limit ?? 50;
    const sortDir = opts.sortDir ?? "desc";
    const position: CompositeCursor = opts.cursor
      ? decodeCompositeCursor(opts.cursor)
      : { entity: {}, meta: {} };
    const baseFilter = opts.filter ?? {};

    const fetchStream = (
      at: StreamPosition,
      query: Pick<AuditLogQueryOptions, "filter" | "metadata">
    ): Promise<AuditLogQueryResult> =>
      at.done
        ? Promise.resolve(EMPTY_PAGE)
        : this.query({
            ...query,
            limit,
            sort: "createdAt",
            sortDir,
            ...(at.cursor && { cursor: at.cursor }),
          });

    const [entityPage, metaPage] = await Promise.all([
      fetchStream(position.entity, {
        filter: { ...baseFilter, entityId: { equals: opts.entityId } },
      }),
      fetchStream(position.meta, {
        filter: baseFilter,
        metadata: { [opts.metadataKey]: { equals: opts.entityId } },
      }),
    ]);

    // Core's order: createdAt in `sortDir`, then id ascending.
    const compare = (a: EntryKey, b: EntryKey) => {
      const byTime =
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      if (byTime !== 0) return sortDir === "asc" ? byTime : -byTime;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    };

    // Resume past the last entry returned, by position in the order rather
    // than by count, so an entry written since the last page shifts nothing.
    const firstAfter = (
      page: AuditLogQueryResult,
      after: StreamPosition["after"]
    ) => {
      if (!after) return 0;
      const i = page.data.findIndex((e) => compare(e, after) > 0);
      return i === -1 ? page.data.length : i;
    };
    const streams = [
      { at: position.entity, page: entityPage },
      { at: position.meta, page: metaPage },
    ].map(({ at, page }) => ({ at, page, next: firstAfter(page, at.after) }));
    const exhausted = (s: (typeof streams)[number]) =>
      s.next >= s.page.data.length;

    const data: AuditLogReadResult[] = [];
    while (data.length < limit) {
      // A stream with core entries not yet fetched could hold the next one.
      if (streams.some((s) => exhausted(s) && s.page.hasMore)) break;
      const live = streams.filter((s) => !exhausted(s));
      if (live.length === 0) break;
      const head = live
        .map((s) => s.page.data[s.next])
        .reduce((min, e) => (compare(e, min) < 0 ? e : min));
      data.push(head);
      for (const s of live) {
        if (s.page.data[s.next].id === head.id) s.next++;
      }
    }

    const resume = (s: (typeof streams)[number]): StreamPosition => {
      if (s.at.done) return s.at;
      if (!exhausted(s)) {
        if (s.next === 0) return s.at;
        const { createdAt, id } = s.page.data[s.next - 1];
        return { cursor: s.at.cursor, after: { createdAt, id } };
      }
      if (s.page.hasMore && s.page.nextCursor) {
        return { cursor: s.page.nextCursor };
      }
      return { done: true };
    };
    const next = { entity: resume(streams[0]), meta: resume(streams[1]) };
    const hasMore = !next.entity.done || !next.meta.done;

    return {
      data,
      hasMore,
      limit,
      nextCursor: hasMore ? encodeCompositeCursor(next) : null,
    };
  }

  // ===========================================================================
  // Internal
  // ===========================================================================

  // Core refuses an empty email or IP address; an empty one means "none".
  private toPayload(entry: AuditLogEntryInput): CreateEntryInput {
    return {
      ...entry,
      source: this.source,
      ...(entry.userEmail === "" && { userEmail: null }),
      ...(entry.ipAddress === "" && { ipAddress: null }),
    };
  }

  // Core's audit routes take flat `filter[field]` / `metadata[key_op]` params.
  private buildListParams(
    options?: AuditLogQueryOptions
  ): AuditLogListEntriesParams {
    const params: AuditLogListEntriesParams = {
      "filter[source]": this.source,
    };

    if (!options) return params;

    if (options.limit != null) params.limit = options.limit;
    if (options.cursor) params.cursor = options.cursor;
    if (options.sort) params.sort = options.sort;
    if (options.sortDir) params.sortDir = options.sortDir;

    if (options.filter) {
      for (const [field, operators] of Object.entries(options.filter)) {
        if (!operators) continue;
        for (const [op, value] of Object.entries(
          operators as Record<string, unknown>
        )) {
          if (value === undefined || value === null) continue;
          if (op === "in" && Array.isArray(value)) {
            params[`filter[${field}]`] = value.join(",");
            params[`filter[${field}_op]`] = "in";
          } else if (["gte", "lte", "gt", "lt"].includes(op)) {
            params[`filter[${field}_${op}]`] = String(value);
          } else if (op === "equals") {
            params[`filter[${field}]`] = String(value);
          } else {
            // contains, startsWith, endsWith
            params[`filter[${field}]`] = String(value);
            params[`filter[${field}_op]`] = op;
          }
        }
      }
    }

    if (options.metadata) {
      for (const [key, operators] of Object.entries(options.metadata)) {
        if (!operators) continue;
        if (operators.equals !== undefined) {
          params[`metadata[${key}_equals]`] = operators.equals;
        }
        if (operators.contains !== undefined) {
          params[`metadata[${key}_contains]`] = operators.contains;
        }
      }
    }

    return params;
  }
}
