import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { safeCacheGet, safeCacheSet } from "../utils/cache.js";
import { startFileServiceCache } from "../utils/fileCache.js";
import { failUnlessRefused } from "../templates/core.js";
import { createCoreClient } from "../coreClient.js";
import type { AxiosError } from "axios";
import {
  CORE_CLIENT,
  CORE_ONCE_CLIENT,
  CORE_PUBLIC_CLIENT,
  purgeServiceToken,
  resetHandler,
} from "../handler.js";

const { handlers, FakeHandler } = vi.hoisted(() => {
  const handlers: FakeHandler[] = [];
  class FakeHandler {
    options: unknown;
    hooks: ((h: FakeHandler) => unknown)[] = [];
    templates = new Map<string, (creds: unknown) => unknown>();
    localClients: { template: string; creds: Record<string, unknown> }[] = [];
    started = false;
    constructor(options: unknown) {
      this.options = options;
      handlers.push(this);
    }
    registerStartupHook(hook: (h: FakeHandler) => unknown) {
      this.hooks.push(hook);
    }
    purged: string[] = [];
    getClient(name: string) {
      return { purgeCredentials: async () => void this.purged.push(name) };
    }
    async handleRequest() {
      throw new Error("no core in this test");
    }
    async registerClientTemplate(
      name: string,
      factory: (c: unknown) => unknown
    ) {
      this.templates.set(name, factory);
    }
    async addLocalTemplateClient(
      template: string,
      creds: Record<string, unknown>
    ) {
      this.localClients.push({ template, creds });
    }
    async start() {
      for (const hook of this.hooks) await hook(this);
      this.started = true;
    }
    async stop() {
      this.started = false;
    }
  }
  return { handlers, FakeHandler };
});

vi.mock("@dianemo/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dianemo/core")>()),
  default: FakeHandler,
}));
vi.mock("@dianemo/backend-redis", () => ({ redisBackend: () => ({}) }));
vi.mock("../utils/fileCache.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/fileCache.js")>()),
  startFileServiceCache: vi.fn(),
  closeFileServiceCache: vi.fn(),
}));

const options = {
  service: "product-service",
  url: "http://core:4001/",
  clientId: "id-123",
  clientSecret: "secret-456",
  requestHandlerKey: "k".repeat(48),
  redis: {} as never,
};

beforeEach(() => {
  handlers.length = 0;
  resetHandler();
});

describe("createCoreClient", () => {
  it("registers one client for core, with its credentials", async () => {
    const core = createCoreClient(options);
    await core.start();

    const [handler] = handlers;
    expect(handler.localClients).toEqual([
      {
        template: "tereo",
        creds: expect.objectContaining({
          baseUrl: "http://core:4001",
          clientId: "id-123",
          clientSecret: "secret-456",
        }),
      },
    ]);

    const clients = handler.templates.get("tereo")!(
      handler.localClients[0].creds
    ) as {
      name: string;
      requestOptions: { defaults: { baseURL: string } };
      authentication: Record<string, unknown> & {
        refreshConfig?: { url: string };
      };
    }[];
    expect(clients.map((c) => c.name)).toEqual([
      CORE_CLIENT,
      CORE_PUBLIC_CLIENT,
    ]);
    expect(clients[0].requestOptions.defaults.baseURL).toBe("http://core:4001");
    expect(clients[0].authentication.type).toBe("oauth2");
    expect(clients[0].authentication.refreshConfig?.url).toBe(
      "http://core:4001/oauth/token"
    );
    expect(clients[1].authentication).toEqual({
      type: "basic",
      username: "id-123",
      password: "secret-456",
    });

    expect(handler.options).toMatchObject({
      keyPrefix: "@tereo-io/sdk:id-123",
    });
    expect(core.audit.isReady()).toBe(true);
    await core.stop();
  });

  it("reads missing options from env, and says which is missing", () => {
    expect(() =>
      createCoreClient({ service: "x", redis: {} as never })
    ).toThrow(/url is required.*CORE_URL/);
  });

  it("scopes the read caches by client id, so services sharing a Redis never share entries", async () => {
    const store = new Map<string, string>();
    const redis = {
      get: async (key: string) => store.get(key) ?? null,
      set: async (key: string, value: string) => void store.set(key, value),
    } as never;

    const first = createCoreClient({ ...options, redis });
    await safeCacheSet("auth-sdk:v1:token:abc", { active: true }, 60);
    expect([...store.keys()]).toEqual([
      "@tereo-io/sdk:id-123:auth-sdk:v1:token:abc",
    ]);
    await first.stop();

    const second = createCoreClient({ ...options, clientId: "other", redis });
    expect(await safeCacheGet("auth-sdk:v1:token:abc")).toBeUndefined();
    await second.stop();
  });

  it("passes channelPrefix to the file cache", async () => {
    const core = createCoreClient({ ...options, channelPrefix: "app1:" });
    await core.start();
    expect(startFileServiceCache).toHaveBeenLastCalledWith({
      channelPrefix: "app1:",
    });
    await core.stop();
  });

  it("allows one client per process until it is stopped", async () => {
    const core = createCoreClient(options);
    expect(() => createCoreClient(options)).toThrow(/already called/);
    await core.stop();
    expect(() => createCoreClient(options)).not.toThrow();
  });
});

describe("the once sub-client", () => {
  it("shares the core client's token and has its own retry rules", async () => {
    const core = createCoreClient(options);
    await core.start();
    const [handler] = handlers;
    const [main] = handler.templates.get("tereo")!(
      handler.localClients[0].creds
    ) as { subClients: unknown[] }[];

    // No `authentication` of its own: @dianemo/core keys it under the parent's.
    expect(main.subClients).toEqual([
      { name: "once", retryOptions: { classifyError: failUnlessRefused } },
    ]);
    expect(CORE_ONCE_CLIENT).toBe(`${CORE_CLIENT}:once`);
    await core.stop();
  });

  it("fails a 5xx or a dropped connection, and leaves a 4xx to the usual rules", () => {
    const err = (status?: number) =>
      ({ response: status ? { status } : undefined }) as AxiosError;
    expect(failUnlessRefused(err(502))).toEqual({ action: "fail" });
    expect(failUnlessRefused(err())).toEqual({ action: "fail" });
    expect(failUnlessRefused(err(429))).toBeUndefined();
    expect(failUnlessRefused(err(401))).toBeUndefined();
  });
});

describe("purgeServiceToken", () => {
  it("drops the core client's stored credentials", async () => {
    const core = createCoreClient(options);
    await purgeServiceToken();
    expect(handlers[0].purged).toEqual([CORE_CLIENT]);
    await core.stop();
  });
});

describe("testMode", () => {
  const nodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = nodeEnv;
  });

  it("accepts test tokens and stubs lookups only when asked for", async () => {
    process.env.NODE_ENV = "test";
    const plain = createCoreClient(options);
    expect(await plain.auth.introspectToken("test-token-u1")).toEqual({
      active: false,
    });
    await expect(plain.files.downloadObject("b", "k")).rejects.toThrow();
    await plain.stop();

    const testing = createCoreClient({ ...options, testMode: true });
    expect(await testing.auth.introspectToken("test-token-u1")).toMatchObject({
      active: true,
      sub: "u1",
    });
    expect((await testing.auth.getUser("u1"))?.id).toBe("u1");
    expect((await testing.files.downloadObject("b", "k")).toString()).toBe(
      "test-file-contents:b/k"
    );
    await testing.stop();
  });

  it("validates testServiceUserId and uses it for the service token", async () => {
    process.env.NODE_ENV = "test";
    expect(() =>
      createCoreClient({ ...options, testMode: true, testServiceUserId: "x" })
    ).toThrow(/testServiceUserId/);
    const id = "123e4567-e89b-42d3-a456-426614174000";
    const core = createCoreClient({
      ...options,
      testMode: true,
      testServiceUserId: id,
    });
    expect(await core.auth.introspectToken("test-token-service")).toMatchObject(
      { user_id: id }
    );
    await core.stop();
  });

  it("is refused in production", () => {
    process.env.NODE_ENV = "production";
    expect(() => createCoreClient({ ...options, testMode: true })).toThrow(
      /testMode .* refused in production/
    );
    process.env.NODE_ENV = "test";
    expect(() =>
      createCoreClient({ ...options, testMode: true, production: true })
    ).toThrow(/refused in production/);
  });
});
