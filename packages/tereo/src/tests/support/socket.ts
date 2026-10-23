import { createTestUser } from "./auth/users.js";
import { browserLogin } from "./browserLogin.js";
import { BASE_URL } from "./auth/constants.js";
import { decodeJwt } from "./auth/tokens.js";
import { expect } from "vitest";

export interface TestSocket {
  /** Resolves with the connect result: null, or the handshake's error. */
  connected: Promise<string | null>;
  /** Resolves when the server closes the connection. */
  closed: Promise<void>;
  /** Event names received, in order. */
  events: { name: string; payload: unknown }[];
  /** Sends an event, as socket.io's `emit`. */
  emit: (name: string) => void;
  close: () => void;
}

/**
 * A socket.io client over a plain WebSocket (Engine.IO v4): enough of the
 * protocol to connect with a token, send and receive events and see a
 * disconnect. `auth` is sent as the handshake's `auth` as is.
 */
export const connect = (
  token: unknown,
  baseUrl: string = BASE_URL,
  auth: Record<string, unknown> = { token }
): TestSocket => {
  const ws = new WebSocket(
    `${baseUrl.replace(/^http/, "ws")}/ws/?EIO=4&transport=websocket`
  );
  const events: TestSocket["events"] = [];
  let settle: (error: string | null) => void;
  const connected = new Promise<string | null>((r) => (settle = r));
  const closed = new Promise<void>((resolve) =>
    ws.addEventListener("close", () => {
      settle("closed before connecting");
      resolve();
    })
  );
  ws.addEventListener("message", ({ data }) => {
    const packet = String(data);
    if (packet.startsWith("0")) ws.send(`40${JSON.stringify(auth)}`);
    else if (packet === "2") ws.send("3");
    else if (packet.startsWith("40")) settle(null);
    else if (packet.startsWith("44")) {
      settle((JSON.parse(packet.slice(2)) as { message: string }).message);
    } else if (packet.startsWith("42")) {
      const [name, payload] = JSON.parse(packet.slice(2)) as [string, unknown];
      events.push({ name, payload });
    }
  });
  return {
    connected,
    closed,
    events,
    emit: (name) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(`42${JSON.stringify([name])}`);
      }
    },
    close: () => ws.close(),
  };
};

export const within = <T>(promise: Promise<T>, ms: number, what: string) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${what} within ${ms}ms`)), ms)
    ),
  ]);

/** Resolves true when the socket is still open after a moment. */
export const stillOpen = (socket: TestSocket, ms = 300) =>
  Promise.race([
    socket.closed.then(() => false),
    new Promise<boolean>((r) => setTimeout(() => r(true), ms)),
  ]);

/** Resolves once an event named `name` has arrived. */
export const received = (socket: TestSocket, name: string, ms = 5000) =>
  within(
    (async () => {
      while (!socket.events.some((e) => e.name === name)) {
        await new Promise((r) => setTimeout(r, 20));
      }
    })(),
    ms,
    `${name} received`
  );

/**
 * A browser login to the client `clientOf` returns, through to tokens: a
 * session with a refresh token.
 */
export const signInFor =
  (clientOf: () => { clientId: string }, redirectUri: string) =>
  async (
    scope = "openid core:account",
    existing: Awaited<ReturnType<typeof createTestUser>> | null = null
  ) => {
    const user = existing ?? (await createTestUser());
    const login = await browserLogin({
      clientId: clientOf().clientId,
      redirectUri,
      scope,
      email: user.email,
      password: user.plainPassword,
    });
    const res = await fetch(`${BASE_URL}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientOf().clientId,
        code: login.code,
        redirect_uri: redirectUri,
        code_verifier: login.verifier,
      }),
    });
    expect(res.status).toBe(200);
    const { access_token, refresh_token } = (await res.json()) as {
      access_token: string;
      refresh_token: string;
    };
    const { sid } = decodeJwt(access_token) as unknown as { sid: string };
    return {
      user,
      accessToken: access_token,
      refreshToken: refresh_token,
      sessionId: sid,
    };
  };
