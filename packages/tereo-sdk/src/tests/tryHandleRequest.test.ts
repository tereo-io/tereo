import { tryHandleRequest } from "../utils/tryHandleRequest.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../utils/logger.js";
import { Readable } from "stream";
import {
  getOriginalResponseData,
  getOriginalStatus,
  RequestError,
} from "../utils/errors.js";

const { handleRequest, purgeServiceToken } = vi.hoisted(() => ({
  handleRequest: vi.fn(),
  purgeServiceToken: vi.fn(),
}));

vi.mock("../handler.js", () => ({
  getHandler: () => ({ handleRequest }),
  purgeServiceToken,
  CORE_PUBLIC_CLIENT: "core:public",
}));

// Shaped like an AxiosError from @dianemo/core's own axios, so not an
// instance of this package's AxiosError class.
const axiosError = (status: number, data?: unknown) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status, data },
  });

const call = (clientName = "core", data?: unknown) =>
  tryHandleRequest(
    { clientName, requestName: "test", method: "POST", url: "/", data },
    "X_0001",
    "failed"
  ).catch((e: unknown) => e);

beforeEach(() => {
  handleRequest.mockReset();
  purgeServiceToken.mockReset();
  vi.restoreAllMocks();
});

describe("tryHandleRequest", () => {
  it("keeps the status of an axios error from another copy of axios", async () => {
    handleRequest.mockRejectedValueOnce(
      axiosError(422, { error: "invalid_declaration" })
    );
    const err = await call();

    expect(getOriginalStatus(err)).toBe(422);
    expect(getOriginalResponseData(err)).toEqual({
      error: "invalid_declaration",
    });
  });

  it("carries core's status and error code beside the SDK code", async () => {
    handleRequest.mockRejectedValueOnce(
      axiosError(404, { error: "not_found", error_description: "No user" })
    );
    const err = (await call()) as RequestError;

    expect(err).toBeInstanceOf(RequestError);
    expect(err.code).toBe("X_0001");
    expect(err.httpStatus).toBe(404);
    expect(err.coreCode).toBe("not_found");
    expect(err.statusCode).toBe(500);
  });

  it("leaves httpStatus undefined when no response came", async () => {
    handleRequest.mockRejectedValueOnce(
      Object.assign(new Error("socket hang up"), {
        isAxiosError: true,
        code: "ECONNRESET",
      })
    );
    const err = (await call()) as RequestError;
    expect(err.httpStatus).toBeUndefined();
    expect(err.coreCode).toBeUndefined();
  });

  it("logs a 4xx at debug and a 5xx or network failure at error", async () => {
    const debug = vi.spyOn(logger, "debug");
    const error = vi.spyOn(logger, "error");

    handleRequest.mockRejectedValueOnce(axiosError(404));
    await call();
    expect(debug).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();

    handleRequest.mockRejectedValueOnce(axiosError(503));
    await call();
    handleRequest.mockRejectedValueOnce(axiosError(429));
    await call();
    expect(error).toHaveBeenCalledTimes(2);
  });

  it("drops a token core rejects and retries once with a fresh one", async () => {
    handleRequest
      .mockRejectedValueOnce(axiosError(401, { error: "invalid_token" }))
      .mockResolvedValueOnce({ status: 200, data: { ok: true } });

    const res = await call();

    expect(purgeServiceToken).toHaveBeenCalledTimes(1);
    expect(handleRequest).toHaveBeenCalledTimes(2);
    expect(res).toMatchObject({ data: { ok: true } });
  });

  it("retries a rejected token only once", async () => {
    handleRequest.mockRejectedValue(axiosError(401));

    const err = (await call()) as RequestError;

    expect(handleRequest).toHaveBeenCalledTimes(2);
    expect(purgeServiceToken).toHaveBeenCalledTimes(1);
    expect(err.httpStatus).toBe(401);
  });

  it("does not retry a 401 for the Basic-auth client or a stream body", async () => {
    handleRequest.mockRejectedValue(axiosError(401));

    await call("core:public");
    await call("core", Readable.from(["x"]));

    expect(handleRequest).toHaveBeenCalledTimes(2);
    expect(purgeServiceToken).not.toHaveBeenCalled();
  });

  it("does not retry other statuses", async () => {
    handleRequest.mockRejectedValue(axiosError(403));
    await call();
    expect(handleRequest).toHaveBeenCalledTimes(1);
  });
});
