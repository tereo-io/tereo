import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { sendUserVerificationEmail } from "../requests/auth/users/index.js";
import { AuthServiceClient, UsersClient } from "../index.js";
import type { AuthServiceUser } from "../types/auth.js";
import { useCacheRedis } from "../utils/cache.js";
import type { Redis } from "ioredis";

const { mockRedis, mockRequests, mockTryHandleRequest } = vi.hoisted(() => {
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
      auth: {
        getUser: vi.fn(),
        getUsersByIds: vi.fn(),
        sendUserVerificationEmail: vi.fn(),
      },
    },
    mockTryHandleRequest: vi.fn(),
  };
});

vi.mock("../handler.js", () => ({
  CORE_CLIENT: "core",
  requests: mockRequests,
  getOriginalStatus: vi.fn(
    (err: unknown) => (err as { originalStatus?: number })?.originalStatus
  ),
}));

vi.mock("../utils/tryHandleRequest.js", () => ({
  tryHandleRequest: mockTryHandleRequest,
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

describe("AuthServiceUser", () => {
  it("carries emailVerified and emailVerifiedAt", () => {
    expectTypeOf<AuthServiceUser["emailVerified"]>().toEqualTypeOf<boolean>();
    expectTypeOf<AuthServiceUser["emailVerifiedAt"]>().toEqualTypeOf<
      string | null
    >();
  });
});

describe("sendVerificationEmail", () => {
  it("posts to the user's email-verification route", async () => {
    mockTryHandleRequest.mockResolvedValue({ status: 202, data: "" });
    await sendUserVerificationEmail(uuid(7));
    expect(mockTryHandleRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        clientName: "core",
        method: "POST",
        url: `/v1/admin/users/${uuid(7)}/email-verification`,
      }),
      "AS_0005",
      expect.any(String)
    );
  });

  it("in test mode resolves without a request", async () => {
    mockRequests.auth.sendUserVerificationEmail.mockClear();
    const { users } = new AuthServiceClient({}, true);
    await expect(users.sendVerificationEmail(uuid(7))).resolves.toBeUndefined();
    expect(mockRequests.auth.sendUserVerificationEmail).not.toHaveBeenCalled();
  });

  it("the users client hands the id to the request", async () => {
    mockRequests.auth.sendUserVerificationEmail.mockResolvedValue(undefined);
    const { users } = new AuthServiceClient();
    expect(users).toBeInstanceOf(UsersClient);
    await users.sendVerificationEmail(uuid(7));
    expect(mockRequests.auth.sendUserVerificationEmail).toHaveBeenCalledWith(
      uuid(7)
    );
  });
});
