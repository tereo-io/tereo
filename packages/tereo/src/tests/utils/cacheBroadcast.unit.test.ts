// @module-tag unit
// @module-tag platform
import { onReconnected, onResubscribed } from "../../utils/cacheBroadcast.js";
import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

describe("onReconnected", () => {
  it("fires on ready after a lost connection, not on the first connect", () => {
    const connection = new EventEmitter();
    const listener = vi.fn();
    onReconnected(connection, listener);

    connection.emit("ready");
    expect(listener).not.toHaveBeenCalled();

    connection.emit("close");
    connection.emit("ready");
    expect(listener).toHaveBeenCalledTimes(1);

    connection.emit("ready");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("onResubscribed", () => {
  it("fires on ready after a lost connection and again once the channel's subscribe is acknowledged", async () => {
    let ack!: () => void;
    const connection = Object.assign(new EventEmitter(), {
      subscribe: vi.fn(
        () => new Promise<void>((resolve) => (ack = () => resolve()))
      ),
    });
    const listener = vi.fn();
    onResubscribed(connection, "branding", listener);

    connection.emit("ready");
    expect(listener).not.toHaveBeenCalled();
    expect(connection.subscribe).not.toHaveBeenCalled();

    connection.emit("close");
    connection.emit("ready");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(connection.subscribe).toHaveBeenCalledWith("branding");

    ack();
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(2));
  });
});
