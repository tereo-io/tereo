import type { NotificationInput } from "../types/notifications.js";
import { NotificationsClient } from "../clients/notifications.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createNotification, getNotification } = vi.hoisted(() => ({
  createNotification: vi.fn(),
  getNotification: vi.fn(),
}));

vi.mock("../requests/notifications/index.js", () => ({
  createNotification,
  getNotification,
}));

const input: NotificationInput = {
  channel: "email",
  recipients: [{ address: "a@example.com" }, { userId: "u", as: "cc" }],
  content: { subject: "Hi", text: "Hello" },
};

beforeEach(() => {
  vi.clearAllMocks();
  createNotification.mockResolvedValue({ id: "n1", status: "pending" });
});

describe("NotificationsClient", () => {
  const client = new NotificationsClient();

  it("posts the input with its idempotency key", async () => {
    const res = await client.send({ ...input, idempotencyKey: "mine" });
    expect(res).toEqual({ id: "n1", status: "pending" });
    expect(createNotification).toHaveBeenCalledWith({
      ...input,
      idempotencyKey: "mine",
    });
  });

  it("generates a key per send when the caller gives none", async () => {
    await client.send(input);
    await client.send(input);
    const keys = createNotification.mock.calls.map(
      (c) => (c[0] as { idempotencyKey: string }).idempotencyKey
    );
    expect(keys[0]).toEqual(expect.any(String));
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("sendAsync rethrows what the request throws", async () => {
    createNotification.mockRejectedValue(new Error("core down"));
    await expect(client.sendAsync(input)).rejects.toThrow("core down");
  });

  it("gets a notification by id", async () => {
    getNotification.mockResolvedValue({ id: "n1", deliveries: [] });
    expect(await client.get("n1")).toEqual({ id: "n1", deliveries: [] });
    expect(getNotification).toHaveBeenCalledWith("n1");
  });

  it("noop sends nothing", async () => {
    const noop = NotificationsClient.noop();
    await noop.sendAsync(input);
    expect(createNotification).not.toHaveBeenCalled();
  });
});
