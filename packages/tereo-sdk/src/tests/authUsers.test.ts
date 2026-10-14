import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthServiceClient } from "../clients/auth.js";
import { useCacheRedis } from "../utils/cache.js";
import type { Redis } from "ioredis";

const { mockRedis, mockRequests } = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    mockRedis: {
      store,
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
        return "OK";
      }),
    },
    mockRequests: {
      auth: { getUser: vi.fn(), getUsersByIds: vi.fn() },
    },
  };
});

vi.mock("../handler.js", () => ({
  requests: mockRequests,
  getOriginalStatus: vi.fn(
    (err: unknown) => (err as { originalStatus?: number })?.originalStatus
  ),
}));

const uuid = (n: number) =>
  `00000000-0000-7000-8000-${n.toString().padStart(12, "0")}`;

const user = (id: string) => ({
  id,
  email: `${id}@example.com`,
  name: null,
  isActive: true,
  userType: "human" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

beforeEach(() => {
  useCacheRedis(mockRedis as unknown as Redis);
  mockRedis.store.clear();
  vi.clearAllMocks();
  mockRequests.auth.getUsersByIds.mockImplementation(async (ids: string[]) =>
    ids.filter((id) => id !== uuid(2)).map(user)
  );
});

describe("AuthServiceClient.getUsers", () => {
  it("fetches every cache miss in one request, and caches what it found and what it did not", async () => {
    const client = new AuthServiceClient();
    const ids = [uuid(1), uuid(2), uuid(3), uuid(1)];

    const first = await client.getUsers(ids);
    expect(mockRequests.auth.getUsersByIds).toHaveBeenCalledTimes(1);
    expect(
      [...mockRequests.auth.getUsersByIds.mock.calls[0][0]].sort()
    ).toEqual([uuid(1), uuid(2), uuid(3)]);
    expect(mockRequests.auth.getUser).not.toHaveBeenCalled();
    expect(first.get(uuid(1))).toEqual(user(uuid(1)));
    expect(first.get(uuid(2))).toBeNull();
    expect(first.size).toBe(3);

    const second = await client.getUsers(ids);
    expect(mockRequests.auth.getUsersByIds).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("splits more than 100 misses into requests of at most 100", async () => {
    const client = new AuthServiceClient();
    const ids = Array.from({ length: 250 }, (_, i) => uuid(i + 10));

    const result = await client.getUsers(ids);
    const sizes = mockRequests.auth.getUsersByIds.mock.calls.map(
      ([chunk]) => chunk.length
    );
    expect(sizes).toEqual([100, 100, 50]);
    expect(result.size).toBe(250);
  });

  it("answers null for an id that is not a UUID, without asking core", async () => {
    const client = new AuthServiceClient();
    const result = await client.getUsers(["not-a-uuid"]);
    expect(result.get("not-a-uuid")).toBeNull();
    expect(mockRequests.auth.getUsersByIds).not.toHaveBeenCalled();
  });
});
