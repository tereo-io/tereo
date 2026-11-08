// @module-tag unit
// @module-tag platform
import { onReconnected } from "../../utils/cacheBroadcast.js";
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
