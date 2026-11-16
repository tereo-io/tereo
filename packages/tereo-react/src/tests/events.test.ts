import { describe, expect, it, vi } from "vitest";
import type { TereoEvent } from "../config.js";
import {
  startTereoEvents,
  type EventSocket,
  type SocketAuth,
} from "../events.js";

type Listener = (...args: unknown[]) => void;

class FakeSocket implements EventSocket {
  active = false;
  connects = 0;
  disconnects = 0;
  listeners = new Map<string, Listener[]>();
  constructor(public auth: SocketAuth) {}
  connect() {
    this.connects++;
    this.active = true;
  }
  disconnect() {
    this.disconnects++;
    this.active = false;
  }
  on(event: string, listener: (...args: never[]) => void) {
    const list = this.listeners.get(event) ?? [];
    list.push(listener as Listener);
    this.listeners.set(event, list);
  }
  emit(event: string, ...args: unknown[]) {
    for (const l of this.listeners.get(event) ?? []) l(...args);
  }
  handshakeToken() {
    let token: string | undefined;
    this.auth((data) => (token = data.token));
    return token;
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

const setup = (
  overrides: { fresh?: boolean; refresh?: () => Promise<unknown> } = {}
) => {
  let token = "t1";
  let fresh = overrides.fresh ?? true;
  let socket!: FakeSocket;
  const scheduled: { fn: () => void; ms: number }[] = [];
  const deps = {
    createSocket: (auth: SocketAuth) => (socket = new FakeSocket(auth)),
    accessToken: () => token,
    tokenIsFresh: () => fresh,
    sessionId: () => "sid-1",
    refresh: vi.fn(
      overrides.refresh ??
        (async () => {
          token = "t2";
          fresh = true;
        })
    ),
    signOut: vi.fn(),
    onEvent: vi.fn(),
    refused: vi.fn(),
    schedule: (fn: () => void, ms: number) => {
      scheduled.push({ fn, ms });
      return () => {};
    },
  };
  const stop = startTereoEvents(deps);
  return {
    deps,
    stop,
    scheduled,
    socket: () => socket,
    expire: () => (fresh = false),
  };
};

describe("startTereoEvents", () => {
  it("connects with the stored token", async () => {
    const t = setup();
    await flush();
    expect(t.socket().connects).toBe(1);
    expect(t.socket().handshakeToken()).toBe("t1");
    expect(t.deps.refresh).not.toHaveBeenCalled();
  });

  it("refreshes a stale token before the first handshake", async () => {
    const t = setup({ fresh: false });
    await flush();
    expect(t.deps.refresh).toHaveBeenCalledTimes(1);
    expect(t.socket().handshakeToken()).toBe("t2");
    expect(t.socket().connects).toBe(1);
  });

  it("does not refresh the token on an access change", async () => {
    const t = setup();
    await flush();
    t.socket().emit("auth:permissions:changed", { reason: "roles_changed" });
    t.socket().emit("auth:organization:changed", { reason: "m" });
    await flush();
    expect(t.deps.refresh).not.toHaveBeenCalled();
  });

  it("maps socket events to TereoEvents", async () => {
    const t = setup();
    await flush();
    const permissions = { reason: "roles_changed", timestamp: 1 };
    const organization = { reason: "m", organizationId: "o", timestamp: 2 };
    const revoked = { sessionId: "sid-other", timestamp: 3 };
    t.socket().emit("auth:permissions:changed", permissions);
    t.socket().emit("auth:organization:changed", organization);
    t.socket().emit("auth:session:revoked", revoked);
    const events: TereoEvent[] = [
      { type: "permissions", payload: permissions },
      { type: "organization", payload: organization },
      { type: "session-revoked", payload: revoked },
    ];
    expect(t.deps.onEvent.mock.calls.map((c) => c[0])).toEqual(events);
  });

  it("signs out when this session is revoked, not another one", async () => {
    const t = setup();
    await flush();
    t.socket().emit("auth:session:revoked", { sessionId: "sid-other" });
    expect(t.deps.signOut).not.toHaveBeenCalled();
    t.socket().emit("auth:session:revoked", { sessionId: "sid-1" });
    t.socket().emit("auth:session:revoked", { sessionId: "sid-1" });
    expect(t.deps.signOut).toHaveBeenCalledTimes(1);
  });

  it("reconnects with a fresh token after tereo closes the socket", async () => {
    const t = setup();
    await flush();
    t.expire();
    t.socket().emit("disconnect", "io server disconnect");
    await flush();
    expect(t.deps.refresh).toHaveBeenCalledTimes(1);
    expect(t.socket().connects).toBe(2);
    expect(t.socket().handshakeToken()).toBe("t2");
  });

  it("does not reconnect when the refresh is refused", async () => {
    const t = setup({
      refresh: async () => {
        throw new Error("invalid_grant");
      },
    });
    await flush();
    t.expire();
    t.socket().emit("disconnect", "io server disconnect");
    await flush();
    expect(t.socket().connects).toBe(1);
  });

  it("retries a transient refusal with backoff", async () => {
    const t = setup();
    await flush();
    t.socket().active = false;
    t.socket().emit("connect_error", new Error("Too many connections"));
    expect(t.scheduled.map((s) => s.ms)).toEqual([1000]);
    t.scheduled[0].fn();
    await flush();
    expect(t.socket().connects).toBe(2);
    t.socket().active = false;
    t.socket().emit("connect_error", new Error("Server is shutting down"));
    expect(t.scheduled.map((s) => s.ms)).toEqual([1000, 2000]);
    expect(t.deps.refresh).not.toHaveBeenCalled();
  });

  it("caps the backoff at 60 seconds", async () => {
    const t = setup();
    await flush();
    for (let i = 0; i < 8; i++) {
      t.socket().active = false;
      t.socket().emit("connect_error", new Error("Too many connections"));
      t.scheduled[i].fn();
      await flush();
    }
    expect(t.scheduled.map((s) => s.ms)).toEqual([
      1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000,
    ]);
  });

  it("answers a token refusal with one refresh, then reconnects with the new token", async () => {
    const t = setup();
    await flush();
    t.socket().active = false;
    t.socket().emit(
      "connect_error",
      new Error("Invalid or expired access token")
    );
    await flush();
    expect(t.deps.refresh).toHaveBeenCalledTimes(1);
    expect(t.socket().connects).toBe(2);
    expect(t.socket().handshakeToken()).toBe("t2");
    expect(t.scheduled).toEqual([]);
  });

  it("stops after a second token refusal and reports it, without signing out", async () => {
    const t = setup();
    await flush();
    const reason = "This token is not issued for core's API";
    t.socket().active = false;
    t.socket().emit("connect_error", new Error(reason));
    await flush();
    t.socket().active = false;
    t.socket().emit("connect_error", new Error(reason));
    await flush();
    expect(t.deps.refresh).toHaveBeenCalledTimes(1);
    expect(t.deps.refused).toHaveBeenCalledWith(reason);
    expect(t.deps.signOut).not.toHaveBeenCalled();
    expect(t.socket().connects).toBe(2);
    expect(t.scheduled).toEqual([]);
  });

  it("allows a fresh refresh for a refusal after a successful connect", async () => {
    const t = setup();
    await flush();
    t.socket().active = false;
    t.socket().emit(
      "connect_error",
      new Error("Invalid or expired access token")
    );
    await flush();
    t.socket().emit("connect");
    t.socket().active = false;
    t.socket().emit(
      "connect_error",
      new Error("Invalid or expired access token")
    );
    await flush();
    expect(t.deps.refresh).toHaveBeenCalledTimes(2);
    expect(t.deps.refused).not.toHaveBeenCalled();
  });

  it("leaves a network error to socket.io's own retries", async () => {
    const t = setup();
    await flush();
    t.socket().emit("connect_error", new Error("xhr poll error"));
    expect(t.scheduled).toEqual([]);
  });

  it("stops: disconnects and ignores its own close", async () => {
    const t = setup();
    await flush();
    t.stop();
    t.socket().emit("disconnect", "io client disconnect");
    t.socket().emit("disconnect", "io server disconnect");
    await flush();
    expect(t.socket().disconnects).toBe(1);
    expect(t.socket().connects).toBe(1);
  });
});
