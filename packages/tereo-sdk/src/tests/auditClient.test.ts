import { AuditLogServiceClient } from "../clients/audit.js";
import { describe, expect, it, vi } from "vitest";

const page = { data: [], hasMore: false, limit: 50, nextCursor: null };
const listEntries = vi.fn().mockResolvedValue(page);
const getEntriesByEntity = vi.fn().mockResolvedValue(page);
const createEntry = vi.fn();
const createBatch = vi.fn();

vi.mock("../requests/audit/index.js", () => ({
  createEntry: (...args: unknown[]) => createEntry(...args),
  createBatch: (...args: unknown[]) => createBatch(...args),
  listEntries: (...args: unknown[]) => listEntries(...args),
  getEntriesByEntity: (...args: unknown[]) => getEntriesByEntity(...args),
}));

describe("AuditLogServiceClient reads", () => {
  const client = new AuditLogServiceClient({ source: "billing" });

  it("scopes query() and getByEntity() to the client's source", async () => {
    await client.query();
    expect(listEntries).toHaveBeenCalledWith(
      expect.objectContaining({ "filter[source]": "billing" })
    );

    await client.getByEntity("Order", "o-1", { organizationId: "org" });
    expect(getEntriesByEntity).toHaveBeenCalledWith(
      "Order",
      "o-1",
      expect.objectContaining({
        "filter[source]": "billing",
        "filter[organizationId]": "org",
      })
    );
  });
});

describe("AuditLogServiceClient.queryByEntityOrMetadata", () => {
  const client = new AuditLogServiceClient({ source: "billing" });
  const at = (minute: number) =>
    new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
  const entry = (id: string, minute: number) => ({ id, createdAt: at(minute) });

  // Newest first, ties broken by id ascending, as core orders them.
  const byEntityId = [
    entry("e10", 10),
    entry("e08", 8),
    entry("both", 6),
    entry("e06", 6),
    entry("e04", 4),
    entry("e02", 2),
  ];
  const byMetadata = [
    entry("m09", 9),
    entry("m07", 7),
    entry("both", 6),
    entry("m06", 6),
    entry("m05", 5),
    entry("m01", 1),
  ];

  const fakeCore = (params: Record<string, string | number>) => {
    const rows = "filter[entityId]" in params ? byEntityId : byMetadata;
    const start = params.cursor ? Number(params.cursor) : 0;
    const limit = Number(params.limit);
    const data = rows.slice(start, start + limit);
    const hasMore = start + limit < rows.length;
    return Promise.resolve({
      data,
      hasMore,
      limit,
      nextCursor: hasMore ? String(start + limit) : null,
    });
  };

  it("pages through both queries without skipping or repeating an entry", async () => {
    listEntries.mockImplementation(fakeCore);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) {
      const res = await client.queryByEntityOrMetadata({
        entityId: "o-1",
        metadataKey: "orderId",
        limit: 3,
        ...(cursor && { cursor }),
      });
      seen.push(...res.data.map((e) => e.id));
      if (!res.hasMore) break;
      cursor = res.nextCursor!;
    }
    expect(seen).toEqual([
      "e10",
      "m09",
      "e08",
      "m07",
      "both",
      "e06",
      "m06",
      "m05",
      "e04",
      "e02",
      "m01",
    ]);
  });

  it("refuses a cursor it did not issue", async () => {
    await expect(
      client.queryByEntityOrMetadata({
        entityId: "o-1",
        metadataKey: "orderId",
        cursor: "garbage",
      })
    ).rejects.toThrow(/Invalid queryByEntityOrMetadata cursor/);
  });
});

describe("AuditLogServiceClient writes", () => {
  it("sends an empty email or IP address as null", async () => {
    createEntry.mockResolvedValue({});
    const client = new AuditLogServiceClient({ source: "billing" });
    await client.logAsync({
      userId: "00000000-0000-7001-8000-000000000001",
      action: "CREATE",
      entityType: "Order",
      entityId: "o-1",
      userEmail: "",
      ipAddress: "",
    });
    expect(createEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "billing",
        userEmail: null,
        ipAddress: null,
      })
    );
  });

  it("leaves per-entry idempotency keys out of a batch, which core refuses", async () => {
    createBatch.mockResolvedValue({ created: 1 });
    const client = new AuditLogServiceClient({ source: "billing" });
    await client.logBatchAsync([
      {
        userId: "00000000-0000-7001-8000-000000000001",
        action: "CREATE",
        entityType: "Order",
        entityId: "o-1",
        idempotencyKey: "k-1",
      },
    ]);
    const [{ entries }] = createBatch.mock.calls[0] as [
      { entries: Record<string, unknown>[] },
    ];
    expect(entries[0]).toMatchObject({ source: "billing", entityId: "o-1" });
    expect(entries[0]).not.toHaveProperty("idempotencyKey");
  });
});
