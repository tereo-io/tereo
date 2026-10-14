import { accessLogErrorMessage } from "../../middleware/accessLog.js";
import { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { logger } from "../../utils/logger.js";
import {
  NotFoundError,
  TooManyRequestsError,
  errorHandler,
} from "../../utils/errors.js";

const handle = (err: unknown) => {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  errorHandler(
    err as Error,
    {} as Request,
    res as unknown as Response,
    vi.fn() as NextFunction
  );
  return {
    status: res.status.mock.calls[0][0],
    body: res.json.mock.calls[0][0],
  };
};

/** Not an AppError, but shaped like one — as a library's HTTP errors are. */
class ForeignError extends Error {
  constructor(
    public statusCode: unknown,
    public code: unknown,
    message: string
  ) {
    super(message);
  }
}

describe("errorHandler", () => {
  it("answers an AppError with its status and code", () => {
    expect(handle(new NotFoundError("No such bucket"))).toEqual({
      status: 404,
      body: { error: "not_found", error_description: "No such bucket" },
    });
  });

  it("adds a rate-limit refusal's retry_after to the body and Retry-After", () => {
    const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() };
    res.status.mockReturnValue(res);
    errorHandler(
      new TooManyRequestsError(7),
      {} as Request,
      res as unknown as Response,
      vi.fn() as NextFunction
    );
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.setHeader).toHaveBeenCalledWith("Retry-After", 7);
    expect(res.json).toHaveBeenCalledWith({
      error: "too_many_requests",
      error_description: "Rate limit exceeded. Please try again later.",
      retry_after: 7,
    });
  });

  it("answers an AppError-shaped error the same way", () => {
    expect(handle(new ForeignError(403, "forbidden", "Nope"))).toEqual({
      status: 403,
      body: { error: "forbidden", error_description: "Nope" },
    });
  });

  it.each([
    ["a non-HTTP status", 200, "ok"],
    ["a non-numeric status", "404", "not_found"],
    ["a missing code", 404, undefined],
  ])("does not trust %s", (_, statusCode, code) => {
    expect(handle(new ForeignError(statusCode, code, "x")).status).toBe(500);
  });

  it("still maps a Prisma write conflict, which has a code but no status", () => {
    expect(
      handle(Object.assign(new Error("write conflict"), { code: "P2034" }))
    ).toMatchObject({ status: 409, body: { error: "version_conflict" } });
  });

  it("answers an unmapped missing-row error with 404 not_found", () => {
    expect(
      handle(Object.assign(new Error("no record"), { code: "P2025" }))
    ).toMatchObject({ status: 404, body: { error: "not_found" } });
  });

  it("answers an unmapped unique violation with 409 conflict", () => {
    expect(
      handle(Object.assign(new Error("duplicate name"), { code: "P2002" }))
    ).toMatchObject({ status: 409, body: { error: "conflict" } });
  });

  /** The pg driver adapter's error, as Prisma 7 nests it. */
  const adapterError = (cause: Record<string, unknown>) => ({
    name: "DriverAdapterError",
    cause,
  });
  const unique = {
    originalCode: "23505",
    kind: "UniqueConstraintViolation",
    constraint: { fields: ["slug"] },
  };
  const foreignKey = {
    originalCode: "23503",
    kind: "ForeignKeyConstraintViolation",
    constraint: { index: "user_roles_role_id_fkey" },
  };
  const restrict = { originalCode: "23001", kind: "postgres", code: "23001" };
  const prismaError = (code: string, cause: Record<string, unknown>) =>
    Object.assign(new Error("db"), {
      code,
      meta: { driverAdapterError: adapterError(cause) },
    });
  const rawAdapterError = (cause: Record<string, unknown>) =>
    Object.assign(new Error("db"), adapterError(cause));

  it.each([
    ["raw SQL (P2010)", prismaError("P2010", unique)],
    ["wrapped by the client (P2039)", prismaError("P2039", unique)],
    ["a raw DriverAdapterError", rawAdapterError(unique)],
  ])("answers a unique violation from %s with 409 conflict", (_, err) => {
    expect(handle(err)).toMatchObject({
      status: 409,
      body: { error: "conflict" },
    });
  });

  it.each([
    ["Prisma (P2003)", Object.assign(new Error("fk"), { code: "P2003" })],
    ["raw SQL (P2010)", prismaError("P2010", foreignKey)],
    ["a RESTRICT delete (P2039)", prismaError("P2039", restrict)],
    ["a raw DriverAdapterError", rawAdapterError(foreignKey)],
  ])("answers a foreign-key violation from %s with 409 conflict", (_, err) => {
    expect(handle(err)).toMatchObject({
      status: 409,
      body: { error: "conflict" },
    });
  });

  it("leaves other database errors a 500", () => {
    expect(
      handle(prismaError("P2010", { originalCode: "22P02", kind: "x" })).status
    ).toBe(500);
  });
});

describe("errorHandler logging", () => {
  const req = {
    method: "GET",
    originalUrl: "/files/buckets/x?token=secret",
  } as Request;
  const run = (err: Error, request: Request = req) => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const res = { status: vi.fn(), json: vi.fn() };
    res.status.mockReturnValue(res);
    errorHandler(err, request, res as unknown as Response, vi.fn());
    const calls = { warn: warn.mock.calls, error: error.mock.calls };
    warn.mockRestore();
    error.mockRestore();
    return calls;
  };

  it("logs a 4xx at warn, without the stack or query string", () => {
    const { warn, error } = run(new NotFoundError("No such bucket"));
    expect(error).toHaveLength(0);
    expect(warn).toHaveLength(1);
    const [fields, message] = warn[0] as unknown as [
      Record<string, unknown>,
      string,
    ];
    expect(fields).toMatchObject({
      method: "GET",
      path: "/files/buckets/x",
      status: 404,
      code: "not_found",
    });
    expect(fields).not.toHaveProperty("err");
    expect(fields).not.toHaveProperty("stack");
    expect(message).toBe("No such bucket");
  });

  it("logs a 5xx at error, with the error under `err`", () => {
    const boom = new Error("boom");
    const { warn, error } = run(boom);
    expect(warn).toHaveLength(0);
    expect(error).toHaveLength(1);
    expect(error[0][0]).toMatchObject({
      method: "GET",
      path: "/files/buckets/x",
      status: 500,
      err: boom,
    });
  });

  it("leaves a share link's token out of the path", () => {
    const { warn } = run(new NotFoundError("Share not found"), {
      method: "GET",
      originalUrl: "/v1/files/shared/s3cr3t-share-token/report.pdf",
    } as Request);
    expect(warn[0][0]).toMatchObject({
      path: "/v1/files/shared/:token/report.pdf",
    });
    expect(JSON.stringify(warn)).not.toContain("s3cr3t");
  });

  it("logs only the first line of a Prisma validation error", () => {
    const err = new Error(
      '\nInvalid `prisma.user.create()` invocation in\n/app/x.ts:1:1\n\n  data: { password: "hunter2-secret" }\n\nArgument `email` is missing.'
    );
    err.name = "PrismaClientValidationError";
    const { error } = run(err);
    const [fields, message] = error[0] as unknown as [{ err: Error }, string];
    expect(message).toBe("Invalid `prisma.user.create()` invocation in");
    expect(fields.err.name).toBe("PrismaClientValidationError");
    expect(fields.err.stack).toMatch(/^PrismaClientValidationError: Invalid/);
    expect(fields.err.stack).toMatch(/\n\s+at /);
    expect(
      JSON.stringify([message, fields.err.message, fields.err.stack])
    ).not.toContain("hunter2");
  });
});

describe("accessLogErrorMessage", () => {
  it("keeps only a Prisma error's class and code", () => {
    const validation = new Error('data: { password: "hunter2-secret" }');
    validation.name = "PrismaClientValidationError";
    expect(accessLogErrorMessage(validation)).toBe(
      "PrismaClientValidationError"
    );
    const known = Object.assign(new Error("Unique constraint failed"), {
      name: "PrismaClientKnownRequestError",
      code: "P2002",
    });
    expect(accessLogErrorMessage(known)).toBe(
      "PrismaClientKnownRequestError P2002"
    );
  });

  it("keeps other errors' messages", () => {
    expect(accessLogErrorMessage(new Error("No such bucket"))).toBe(
      "No such bucket"
    );
    expect(accessLogErrorMessage(undefined)).toBeUndefined();
  });
});
