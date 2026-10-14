import { WebhookServiceClient } from "../clients/webhooks.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuditLogServiceClient } from "../clients/audit.js";

const { createEntry, createBatch, emitEvent, emitBatch } = vi.hoisted(() => ({
  createEntry: vi.fn(),
  createBatch: vi.fn(),
  emitEvent: vi.fn(),
  emitBatch: vi.fn(),
}));

vi.mock("../requests/audit/index.js", () => ({ createEntry, createBatch }));
vi.mock("../requests/webhooks/index.js", () => ({ emitEvent, emitBatch }));

const entry = {
  userId: "00000000-0000-7001-8000-000000000001",
  action: "CREATE" as const,
  entityType: "Item",
  entityId: "1",
};
const event = {
  organizationId: "o",
  eventType: "item.created",
  entityType: "Item",
  entityId: "1",
  data: {},
};

const sentKey = (fn: ReturnType<typeof vi.fn>, call = 0) =>
  (fn.mock.calls[call][0] as { idempotencyKey?: string }).idempotencyKey;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("one idempotency key per direct write", () => {
  const audit = new AuditLogServiceClient({ source: "billing" });
  const webhooks = new WebhookServiceClient();

  it("gives each audit write its own key, and keeps one the caller set", async () => {
    await audit.logAsync(entry);
    await audit.logAsync(entry);
    await audit.logAsync({ ...entry, idempotencyKey: "mine" });

    expect(sentKey(createEntry, 0)).toEqual(expect.any(String));
    expect(sentKey(createEntry, 1)).toEqual(expect.any(String));
    expect(sentKey(createEntry, 0)).not.toBe(sentKey(createEntry, 1));
    expect(sentKey(createEntry, 2)).toBe("mine");
  });

  it("gives an audit batch one key, and none to its entries", async () => {
    await audit.logBatchAsync([{ ...entry, idempotencyKey: "dropped" }]);
    const [input] = createBatch.mock.calls[0] as [
      { idempotencyKey?: string; entries: object[] },
    ];
    expect(input.idempotencyKey).toEqual(expect.any(String));
    expect(input.entries[0]).not.toHaveProperty("idempotencyKey");
  });

  it("gives each webhook event its own key, and keeps one the caller set", async () => {
    await webhooks.emitAsync(event);
    await webhooks.emitAsync({ ...event, idempotencyKey: "mine" });
    await webhooks.emitBatchAsync([event, event]);

    expect(sentKey(emitEvent, 0)).toEqual(expect.any(String));
    expect(sentKey(emitEvent, 1)).toBe("mine");
    const [{ events }] = emitBatch.mock.calls[0] as [
      { events: { idempotencyKey?: string }[] },
    ];
    expect(events[0].idempotencyKey).toEqual(expect.any(String));
    expect(events[0].idempotencyKey).not.toBe(events[1].idempotencyKey);
  });

  it("covers the best-effort log() and emit(), which go through the same calls", async () => {
    audit.log(entry);
    webhooks.emit(event);
    await vi.waitFor(() => {
      expect(sentKey(createEntry)).toEqual(expect.any(String));
      expect(sentKey(emitEvent)).toEqual(expect.any(String));
    });
  });
});
