import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthServiceClient } from "../clients/auth.js";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock("../utils/tryHandleRequest.js", () => ({ tryHandleRequest: send }));
vi.mock("../handler.js", () => ({
  CORE_CLIENT: "core",
  requests: {
    auth: {
      getOwnService: async () =>
        (await import("../requests/auth/service/index.js")).getOwnService(),
    },
  },
  getOriginalStatus: vi.fn(),
}));

const own = {
  id: "00000000-0000-7000-8000-000000000042",
  slug: "inventory-service",
  name: "Inventory",
  namespace: "inventory",
  isActive: true,
  provisioned: true,
  declarationVersion: "1.2.0",
  declarationHash: "abc",
  declaredAt: "2026-10-19T00:00:00.000Z",
  access: [
    {
      kind: "role",
      target: "audit_writer",
      status: "approved",
      decidedAt: "2026-10-19T00:00:00.000Z",
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  send.mockResolvedValue({ data: own });
});

describe("AuthServiceClient.getService", () => {
  it("reads GET /v1/account/service as the service's own client", async () => {
    expect(await new AuthServiceClient().getService()).toEqual(own);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({
      clientName: "core",
      method: "GET",
      url: "/v1/account/service",
    });
  });

  it("answers with a stub in test mode, without calling core", async () => {
    const service = await new AuthServiceClient({}, true).getService();
    expect(service).toMatchObject({ slug: "test-service", access: [] });
    expect(send).not.toHaveBeenCalled();
  });
});
