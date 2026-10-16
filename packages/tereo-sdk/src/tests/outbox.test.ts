import type { NotificationsClient } from "../clients/notifications.js";
import { outboxTableSql, quoteTable } from "../utils/outboxSchema.js";
import { InvalidAuditEntryError } from "../utils/auditSchemas.js";
import type { AuditLogServiceClient } from "../clients/audit.js";
import type { OutboxRow, SqlClient } from "../types/outbox.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebhookServiceClient } from "../clients/webhooks.js";
import type { EmitEventParams } from "../types/webhooks.js";
import { OutboxClient } from "../clients/outbox.js";
import { RequestError } from "../utils/errors.js";

/** Records every statement; `claimed` is what the next claim returns. */
const fakeDb = (affected: (query: string) => number = () => 1) => {
  const calls: { query: string; values: unknown[] }[] = [];
  let claimed: OutboxRow[] = [];
  const db: SqlClient = {
    $executeRawUnsafe: async (query, ...values) => {
      calls.push({ query, values });
      return affected(query);
    },
    $queryRawUnsafe: async <T>(query: string, ...values: unknown[]) => {
      calls.push({ query, values });
      const rows = claimed;
      claimed = [];
      return rows as T;
    },
  };
  return { db, calls, claim: (rows: OutboxRow[]) => (claimed = rows) };
};

const row = (over: Partial<OutboxRow> = {}): OutboxRow => ({
  id: "0190a3c4-0000-7000-8000-000000000001",
  destination: "webhook",
  payload: {
    organizationId: "o",
    eventType: "product.item.created",
    entityType: "Item",
    entityId: "1",
    data: {},
  },
  traceparent: null,
  tracestate: null,
  created_at: new Date(),
  next_attempt_at: new Date(),
  claimed_at: new Date(),
  claimed_by: "w",
  attempts: 0,
  last_error: null,
  dead_lettered_at: null,
  ...over,
});

const logAsync = vi.fn();
const audit = { logAsync } as unknown as AuditLogServiceClient;
const sendAsync = vi.fn();
const notifications = { sendAsync } as unknown as NotificationsClient;
let webhooks: WebhookServiceClient;

const make = (db: SqlClient, maxAttempts = 3) =>
  new OutboxClient(
    { db, table: "billing.core_outbox", maxAttempts },
    { audit, webhooks, notifications }
  );

beforeEach(() => {
  logAsync.mockReset();
  sendAsync.mockReset();
  webhooks = new WebhookServiceClient({ eventTypes: ["product.item.created"] });
});

describe("outbox writers", () => {
  it("insert into the caller's transaction", async () => {
    const app = fakeDb();
    const tx = fakeDb();
    const outbox = make(app.db);

    await outbox.emit(tx.db, row().payload as never);
    await outbox.audit(tx.db, {
      userId: "00000000-0000-7001-8000-000000000001",
      action: "CREATE",
      entityType: "Item",
      entityId: "1",
    });

    expect(app.calls).toHaveLength(0);
    expect(tx.calls.map((c) => c.values[1])).toEqual(["webhook", "audit"]);
    expect(tx.calls[0].query).toContain(`INSERT INTO "billing"."core_outbox"`);
    expect(JSON.parse(tx.calls[0].values[2] as string)).toMatchObject({
      eventType: "product.item.created",
    });
  });

  it("refuse an undeclared event type before writing", async () => {
    const tx = fakeDb();
    await expect(
      make(fakeDb().db).emit(tx.db, {
        ...(row().payload as EmitEventParams),
        eventType: "typo",
      })
    ).rejects.toThrow(/Unknown event type/);
    expect(tx.calls).toHaveLength(0);
  });

  it("refuse an invalid audit entry before writing", async () => {
    const tx = fakeDb();
    await expect(
      make(fakeDb().db).audit(tx.db, {
        userId: "not-a-uuid",
        action: "CREATE",
        entityType: "Item",
        entityId: "1",
      })
    ).rejects.toThrow(/userId must be a UUID/);
    expect(tx.calls).toHaveLength(0);
  });
});

const email = {
  channel: "email" as const,
  recipients: [{ address: "a@example.com" }],
  content: { subject: "Hi", text: "Hello" },
};

describe("outbox.notify", () => {
  it("inserts one notification row in the caller's transaction", async () => {
    const app = fakeDb();
    const tx = fakeDb();
    await make(app.db).notify(tx.db, email);
    expect(app.calls).toHaveLength(0);
    expect(tx.calls).toHaveLength(1);
    expect(tx.calls[0].values[1]).toBe("notification");
    expect(JSON.parse(tx.calls[0].values[2] as string)).toEqual(email);
  });

  it("refuses an unknown channel or a bad recipient count before writing", async () => {
    const tx = fakeDb();
    const outbox = make(fakeDb().db);
    await expect(
      outbox.notify(tx.db, { ...email, channel: "pigeon" } as never)
    ).rejects.toThrow(/channel/);
    await expect(
      outbox.notify(tx.db, { ...email, recipients: [] })
    ).rejects.toThrow(/recipients/);
    await expect(
      outbox.notify(tx.db, {
        ...email,
        recipients: Array.from({ length: 51 }, () => ({ address: "a@b.co" })),
      })
    ).rejects.toThrow(/recipients/);
    expect(tx.calls).toHaveLength(0);
  });

  it("refuses an email with no `to` recipient before writing", async () => {
    const tx = fakeDb();
    const outbox = make(fakeDb().db);
    await expect(
      outbox.notify(tx.db, {
        ...email,
        recipients: [
          { address: "a@example.com", as: "cc" },
          { address: "b@example.com", as: "bcc" },
        ],
      })
    ).rejects.toThrow(/`to`/);
    expect(tx.calls).toHaveLength(0);
  });

  it("counts a recipient with no `as` as `to`", async () => {
    const tx = fakeDb();
    await make(fakeDb().db).notify(tx.db, {
      ...email,
      recipients: [
        { address: "a@example.com", as: "cc" },
        { address: "b@example.com" },
      ],
    });
    expect(tx.calls).toHaveLength(1);
  });
});

describe("outbox reaper", () => {
  it("relays a notification row with its id as the idempotency key", async () => {
    const app = fakeDb();
    sendAsync.mockResolvedValue({ id: "n", status: "pending" });
    app.claim([row({ destination: "notification", payload: email })]);
    await make(app.db).processBatch();
    expect(sendAsync).toHaveBeenCalledWith({
      ...email,
      idempotencyKey: row().id,
    });
    expect(app.calls.at(-1)?.query).toContain("DELETE FROM");
  });

  it("dead-letters a notification core rejects with 400 and retries a 403", async () => {
    const app = fakeDb();
    const rejected = (status: number) =>
      new RequestError("request_failed", `HTTP ${status}`, {
        metadata: { originalError: { status } },
      });
    sendAsync.mockRejectedValue(rejected(400));
    app.claim([row({ destination: "notification", payload: email })]);
    await make(app.db, 100).processBatch();
    expect(app.calls.at(-1)!.query).toContain('"dead_lettered_at" = NOW()');

    sendAsync.mockRejectedValue(rejected(403));
    app.claim([row({ destination: "notification", payload: email })]);
    await make(app.db, 100).processBatch();
    expect(app.calls.at(-1)!.query).toContain('"next_attempt_at" = $4');
  });

  it("sends a row with its id as the idempotency key, then deletes it", async () => {
    const app = fakeDb();
    const emitAsync = vi
      .spyOn(webhooks, "emitAsync")
      .mockResolvedValue({ deliveriesCreated: 1 });
    app.claim([row()]);

    expect(await make(app.db).processBatch()).toBe(1);
    expect(emitAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: row().id,
        eventType: "product.item.created",
      })
    );
    expect(app.calls.at(-1)?.query).toContain("DELETE FROM");
  });

  it("dispatches audit rows through the audit client", async () => {
    const app = fakeDb();
    app.claim([row({ destination: "audit", payload: { userId: "u" } })]);
    await make(app.db).processBatch();
    expect(logAsync).toHaveBeenCalledWith({
      userId: "u",
      idempotencyKey: row().id,
    });
  });

  it("backs off a failure, and dead-letters it after maxAttempts", async () => {
    const app = fakeDb();
    vi.spyOn(webhooks, "emitAsync").mockRejectedValue(new Error("core down"));

    app.claim([row({ attempts: 0 })]);
    await make(app.db, 3).processBatch();
    const retry = app.calls.at(-1)!;
    expect(retry.query).toContain('"next_attempt_at" = $4');
    expect(retry.values.slice(1, 3)).toEqual([1, "core down"]);

    app.claim([row({ attempts: 2 })]);
    await make(app.db, 3).processBatch();
    const dead = app.calls.at(-1)!;
    expect(dead.query).toContain('"dead_lettered_at" = NOW()');
    expect(dead.values[1]).toBe(3);
  });

  it("dead-letters a row core rejects with a 4xx on the first attempt, and retries one refused for access still awaiting approval", async () => {
    const app = fakeDb();
    const rejected = (status: number) =>
      new RequestError("request_failed", `HTTP ${status}`, {
        metadata: { originalError: { status } },
      });
    const emitAsync = vi.spyOn(webhooks, "emitAsync");

    emitAsync.mockRejectedValue(rejected(400));
    app.claim([row({ attempts: 0 })]);
    await make(app.db, 100).processBatch();
    expect(app.calls.at(-1)!.query).toContain('"dead_lettered_at" = NOW()');

    for (const status of [401, 403, 409, 429, 503]) {
      emitAsync.mockRejectedValue(rejected(status));
      app.claim([row({ attempts: 0 })]);
      await make(app.db, 100).processBatch();
      expect(app.calls.at(-1)!.query).toContain('"next_attempt_at" = $4');
    }
  });

  it("dead-letters an audit row the SDK finds invalid on the first attempt", async () => {
    const app = fakeDb();
    logAsync.mockRejectedValue(new InvalidAuditEntryError("bad entry"));
    app.claim([row({ destination: "audit", attempts: 0 })]);
    await make(app.db, 100).processBatch();
    expect(app.calls.at(-1)!.query).toContain('"dead_lettered_at" = NOW()');
  });

  it("dead-letters a webhook row whose event type is no longer declared on the first attempt", async () => {
    const app = fakeDb();
    webhooks.useEventTypes(["product.item.updated"]);
    app.claim([row({ attempts: 0 })]);
    await make(app.db, 100).processBatch();
    expect(app.calls.at(-1)!.query).toContain('"dead_lettered_at" = NOW()');
  });

  it("dead-letters a row with no dispatcher", async () => {
    const app = fakeDb();
    app.claim([row({ destination: "carrier-pigeon" })]);
    await make(app.db).processBatch();
    expect(app.calls.at(-1)?.query).toContain('"dead_lettered_at" = NOW()');
  });

  it("renews each row's claim just before sending it, and acts only on rows it still holds", async () => {
    const app = fakeDb();
    vi.spyOn(webhooks, "emitAsync").mockResolvedValue({ deliveriesCreated: 1 });
    app.claim([row()]);
    await make(app.db).processBatch();

    const [claim, renew, del] = app.calls;
    const workerId = claim.values[0];
    expect(renew.query).toContain('SET "claimed_at" = NOW()');
    expect(renew.query).toContain('"claimed_by" = $2');
    expect(renew.values).toEqual([row().id, workerId]);
    expect(del.query).toContain('"claimed_by" = $2');
    expect(del.values).toEqual([row().id, workerId]);

    vi.spyOn(webhooks, "emitAsync").mockRejectedValue(new Error("core down"));
    app.claim([row()]);
    await make(app.db).processBatch();
    const retry = app.calls.at(-1)!;
    expect(retry.query).toContain('"claimed_by" = $5');
    expect(retry.values[4]).toBe(app.calls.at(-3)!.values[0]);
  });

  it("skips a row whose claim lapsed and another worker took", async () => {
    const app = fakeDb((query) =>
      query.includes('"claimed_at" = NOW()') ? 0 : 1
    );
    const emitAsync = vi
      .spyOn(webhooks, "emitAsync")
      .mockResolvedValue({ deliveriesCreated: 1 });
    app.claim([row()]);

    await make(app.db).processBatch();

    expect(emitAsync).not.toHaveBeenCalled();
    expect(app.calls.some((c) => c.query.includes("DELETE"))).toBe(false);
  });
});

describe("outbox table", () => {
  it("quotes plain names and refuses anything else", () => {
    expect(quoteTable("core_outbox")).toBe('"core_outbox"');
    expect(quoteTable("billing.core_outbox")).toBe('"billing"."core_outbox"');
    for (const bad of ['x"; drop table y; --', "Outbox", "a.b.c", ""]) {
      expect(() => quoteTable(bad)).toThrow();
    }
  });

  it("has SQL to create it", () => {
    const sql = outboxTableSql("billing.core_outbox");
    expect(sql).toContain('CREATE TABLE "billing"."core_outbox"');
    expect(sql).toContain('CREATE INDEX "core_outbox_pending_idx"');
  });
});
