import { BASE_URL, createTestClient, createTestUser } from "./support/auth.js";
import { connect, stillOpen, within } from "./support/socket.js";
import { browserLogin } from "./support/browserLogin.js";
import { createServer, type Server } from "node:http";
import { describe, expect, it, vi } from "vitest";

/**
 * A socket's token can die without anything closing the socket — its session
 * rotated away by a refresh is one. Each node checks its sockets' tokens
 * again every WEBSOCKET_REVALIDATE_INTERVAL_SECONDS and closes those.
 */

const REDIRECT_URI = "http://localhost:3000/websocket-revalidate-callback";

const listen = (server: Server) =>
  new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve((server.address() as { port: number }).port)
    );
  });

const token = (body: Record<string, string>) =>
  fetch(`${BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });

describe("periodic re-check of sockets' tokens", () => {
  it("closes the socket of a token whose session a refresh rotated away", async () => {
    const client = await createTestClient({ redirectUris: [REDIRECT_URI] });
    const user = await createTestUser();
    const login = await browserLogin({
      clientId: client.clientId,
      redirectUri: REDIRECT_URI,
      scope: "openid core:account",
      email: user.email,
      password: user.plainPassword,
    });
    const issued = await token({
      grant_type: "authorization_code",
      client_id: client.clientId,
      code: login.code,
      redirect_uri: REDIRECT_URI,
      code_verifier: login.verifier,
    });
    expect(issued.status).toBe(200);
    const first = (await issued.json()) as {
      access_token: string;
      refresh_token: string;
    };

    // A server of this process's own, re-checking every second.
    const saved = process.env.WEBSOCKET_REVALIDATE_INTERVAL_SECONDS;
    process.env.WEBSOCKET_REVALIDATE_INTERVAL_SECONDS = "1";
    vi.resetModules();
    // The fresh modules verify tokens with keys of their own loading.
    await (await import("../utils/keys.js")).loadKeys();
    const ws = await import("../websocket/index.js");
    const server = createServer();
    await ws.initializeWebSocket(server);
    const url = `http://127.0.0.1:${await listen(server)}`;

    const rotated = connect(first.access_token, url);
    let current: ReturnType<typeof connect> | null = null;
    try {
      expect(await rotated.connected).toBeNull();
      const refreshed = await token({
        grant_type: "refresh_token",
        client_id: client.clientId,
        refresh_token: first.refresh_token,
      });
      expect(refreshed.status).toBe(200);
      const { access_token } = (await refreshed.json()) as {
        access_token: string;
      };
      current = connect(access_token, url);
      expect(await current.connected).toBeNull();

      await within(rotated.closed, 5000, "rotated token's socket closed");
      expect(await stillOpen(current, 1500)).toBe(true);
    } finally {
      rotated.close();
      current?.close();
      await ws.shutdownWebSocket();
      server.closeAllConnections();
      server.close();
      if (saved === undefined) {
        delete process.env.WEBSOCKET_REVALIDATE_INTERVAL_SECONDS;
      } else process.env.WEBSOCKET_REVALIDATE_INTERVAL_SECONDS = saved;
      vi.resetModules();
    }
  }, 30_000);
});
