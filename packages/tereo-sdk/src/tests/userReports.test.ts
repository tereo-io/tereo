import { AuthServiceClient, RequestError, UsersClient } from "../index.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CORE_CLIENT } from "../handler.js";
import {
  clearUserReportsTo,
  listUserReports,
  setUserReportsTo,
} from "../requests/auth/users/index.js";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../utils/tryHandleRequest.js", () => ({ tryHandleRequest: send }));

const USER = "00000000-0000-7000-8000-0000000000a1";
const MANAGER = "00000000-0000-7000-8000-0000000000a2";

const report = {
  id: MANAGER,
  email: "r@example.com",
  name: null,
  isActive: false,
  userType: "human",
  reportsToId: USER,
  depth: 1,
};

const coreAnswered = (httpStatus: number) =>
  new RequestError("AS_0119", "Failed", { httpStatus });

beforeEach(() => {
  send.mockReset();
  send.mockResolvedValue({ data: { ok: true } });
});

describe("reports-to requests", () => {
  it.each([
    [
      "listUserReports",
      () => listUserReports(USER),
      "core.auth.listUserReports",
      "GET",
      `/v1/admin/users/${USER}/reports`,
      "AS_0119",
    ],
    [
      "setUserReportsTo",
      () => setUserReportsTo(USER, MANAGER),
      "core.auth.setUserReportsTo",
      "PUT",
      `/v1/admin/users/${USER}/reports-to`,
      "AS_0120",
    ],
    [
      "clearUserReportsTo",
      () => clearUserReportsTo(USER),
      "core.auth.clearUserReportsTo",
      "DELETE",
      `/v1/admin/users/${USER}/reports-to`,
      "AS_0121",
    ],
  ])("%s", async (_name, call, requestName, method, url, code) => {
    await call();

    expect(send.mock.calls[0][0]).toMatchObject({
      clientName: CORE_CLIENT,
      requestName,
      method,
      url,
    });
    expect(send.mock.calls[0][1]).toBe(code);
  });

  it("sends transitive only when set", async () => {
    await listUserReports(USER, { transitive: true });
    await listUserReports(USER, {});

    expect(send.mock.calls[0][0].params).toEqual({ transitive: true });
    expect(send.mock.calls[1][0].params).toEqual({});
  });

  it("sends the manager as userId in the body", async () => {
    await setUserReportsTo(USER, MANAGER);

    expect(send.mock.calls[0][0].data).toEqual({ userId: MANAGER });
  });
});

describe("AuthServiceClient.listUserReports", () => {
  it("returns the data", async () => {
    send.mockResolvedValue({ data: { data: [report], nextCursor: null } });

    expect(
      await new AuthServiceClient().listUserReports(USER, { transitive: true })
    ).toEqual([report]);
  });

  it("returns null when core answers 404", async () => {
    send.mockRejectedValue(coreAnswered(404));

    expect(await new AuthServiceClient().listUserReports(USER)).toBeNull();
  });

  it.each([422, 403])("rejects when core answers %i", async (status) => {
    send.mockRejectedValue(coreAnswered(status));

    await expect(
      new AuthServiceClient().listUserReports(USER)
    ).rejects.toMatchObject({ name: "RequestError", httpStatus: status });
  });

  it("returns no reports in test mode, without calling core", async () => {
    expect(await new AuthServiceClient({}, true).listUserReports(USER)).toEqual(
      []
    );
    expect(send).not.toHaveBeenCalled();
  });
});

describe("UsersClient reports-to", () => {
  it("setReportsTo returns core's answer", async () => {
    const answer = { userId: USER, reportsTo: null };
    send.mockResolvedValue({ data: answer });

    expect(await new UsersClient().setReportsTo(USER, MANAGER)).toEqual(answer);
    expect(send.mock.calls[0][0]).toMatchObject({
      method: "PUT",
      data: { userId: MANAGER },
    });
  });

  it("clearReportsTo sends the DELETE", async () => {
    await new UsersClient().clearReportsTo(USER);

    expect(send.mock.calls[0][0]).toMatchObject({
      method: "DELETE",
      url: `/v1/admin/users/${USER}/reports-to`,
    });
  });

  it("makes no request in test mode", async () => {
    const users = new UsersClient(true);

    expect(await users.setReportsTo(USER, MANAGER)).toEqual({
      userId: USER,
      reportsTo: null,
    });
    await users.clearReportsTo(USER);
    expect(send).not.toHaveBeenCalled();
  });
});
