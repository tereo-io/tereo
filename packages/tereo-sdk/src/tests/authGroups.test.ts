import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthServiceClient, RequestError } from "../index.js";
import { CORE_CLIENT } from "../handler.js";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../utils/tryHandleRequest.js", () => ({ tryHandleRequest: send }));

const USER = "00000000-0000-7000-8000-0000000000a1";
const GROUP = "00000000-0000-7000-8000-0000000000b1";

const group = {
  id: GROUP,
  organizationId: null,
  slug: "analysts",
  name: "Analysts",
  description: null,
  definitionSource: "local",
  membershipSource: "local",
  unprovisionedAt: null,
  archivedAt: null,
  createdAt: "2026-11-13T00:00:00.000Z",
  updatedAt: "2026-11-13T00:00:00.000Z",
  memberCount: 1,
  managedBy: null,
  skippedMemberCount: 0,
};

const coreAnswered = (httpStatus: number) =>
  new RequestError("AS_0117", "Failed", { httpStatus });

beforeEach(() => {
  send.mockReset();
});

describe("AuthServiceClient.listUserGroups", () => {
  it("reads GET /v1/admin/users/:id/groups over CORE_CLIENT and returns the groups", async () => {
    send.mockResolvedValue({
      data: { data: [{ ...group, organization: null }], nextCursor: null },
    });

    const groups = await new AuthServiceClient().listUserGroups(USER, {
      includeArchived: true,
    });

    expect(groups).toEqual([{ ...group, organization: null }]);
    expect(send.mock.calls[0][0]).toMatchObject({
      clientName: CORE_CLIENT,
      method: "GET",
      url: `/v1/admin/users/${USER}/groups`,
      params: { includeArchived: true },
    });
  });

  it("returns null when core answers 404", async () => {
    send.mockRejectedValue(coreAnswered(404));

    expect(await new AuthServiceClient().listUserGroups(USER)).toBeNull();
  });

  it.each([403, 500])(
    "rejects with the RequestError when core answers %i",
    async (status) => {
      send.mockRejectedValue(coreAnswered(status));

      await expect(
        new AuthServiceClient().listUserGroups(USER)
      ).rejects.toMatchObject({ name: "RequestError", httpStatus: status });
    }
  );

  it("rejects with no httpStatus when core cannot be reached", async () => {
    send.mockRejectedValue(new RequestError("AS_0117", "Failed"));

    const err = await new AuthServiceClient()
      .listUserGroups(USER)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RequestError);
    expect((err as RequestError).httpStatus).toBeUndefined();
  });

  it("returns no groups in test mode, without calling core", async () => {
    expect(await new AuthServiceClient({}, true).listUserGroups(USER)).toEqual(
      []
    );
    expect(send).not.toHaveBeenCalled();
  });
});

describe("AuthServiceClient.getGroup", () => {
  it("reads GET /v1/admin/groups/:id over CORE_CLIENT", async () => {
    send.mockResolvedValue({ data: group });

    expect(await new AuthServiceClient().getGroup(GROUP)).toEqual(group);
    expect(send.mock.calls[0][0]).toMatchObject({
      clientName: CORE_CLIENT,
      method: "GET",
      url: `/v1/admin/groups/${GROUP}`,
    });
  });

  it("returns null when core answers 404", async () => {
    send.mockRejectedValue(coreAnswered(404));

    expect(await new AuthServiceClient().getGroup(GROUP)).toBeNull();
  });

  it("rejects with the RequestError when core answers 403", async () => {
    send.mockRejectedValue(coreAnswered(403));

    await expect(new AuthServiceClient().getGroup(GROUP)).rejects.toMatchObject(
      { httpStatus: 403 }
    );
  });

  it("returns a stub for any id in test mode, without calling core", async () => {
    const stub = await new AuthServiceClient({}, true).getGroup(GROUP);

    expect(stub).toMatchObject({
      id: GROUP,
      organizationId: null,
      archivedAt: null,
      definitionSource: "local",
    });
    expect(send).not.toHaveBeenCalled();
  });
});
