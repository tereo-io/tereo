// @module-tag unit
// @module-tag auth
import { guardArchived, guardArchivedById } from "../../utils/guardArchived.js";
import { describe, expect, it, vi } from "vitest";
import { Request, Response } from "express";
import {
  AlreadyArchivedError,
  ArchivedError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../../utils/errors.js";

const req = (over: Partial<Request> = {}): Request =>
  ({ method: "GET", path: "/", ...over }) as Request;

const run = async (
  handler: ReturnType<typeof guardArchived>,
  r: Request
): Promise<unknown> => {
  const next = vi.fn();
  await (
    handler as unknown as (
      rq: Request,
      rs: Response,
      n: typeof next
    ) => Promise<void>
  )(r, {} as Response, next);
  expect(next).toHaveBeenCalledTimes(1);
  return next.mock.calls[0][0];
};

describe("guardArchived", () => {
  const archived = { archivedAt: new Date("2026-01-01") };
  const live = { archivedAt: null };

  it("passes through a live row untouched", async () => {
    const err = await run(
      guardArchived(async () => live),
      req({ method: "PATCH" })
    );
    expect(err).toBeUndefined();
  });

  it("blocks a non-whitelisted mutation on an archived row with ArchivedError (409)", async () => {
    const err = await run(
      guardArchived(async () => archived),
      req({ method: "PATCH" })
    );
    expect(err).toBeInstanceOf(ArchivedError);
    expect((err as ArchivedError).statusCode).toBe(409);
    expect((err as ArchivedError).code).toBe("resource_archived");
  });

  it("answers POST /archive on an archived row with AlreadyArchivedError (409)", async () => {
    const err = await run(
      guardArchived(async () => archived),
      req({ method: "POST", path: "/archive" })
    );
    expect(err).toBeInstanceOf(AlreadyArchivedError);
    expect((err as AlreadyArchivedError).statusCode).toBe(409);
    expect((err as AlreadyArchivedError).code).toBe("already_archived");
  });

  it("allows GET, DELETE / and POST /restore on an archived row (default whitelist)", async () => {
    expect(
      await run(
        guardArchived(async () => archived),
        req({ method: "GET", path: "/members" })
      )
    ).toBeUndefined();
    expect(
      await run(
        guardArchived(async () => archived),
        req({ method: "DELETE", path: "/" })
      )
    ).toBeUndefined();
    expect(
      await run(
        guardArchived(async () => archived),
        req({ method: "POST", path: "/restore" })
      )
    ).toBeUndefined();
  });

  it("falls through when the row is missing so the route produces its own 404", async () => {
    const err = await run(
      guardArchived(async () => null),
      req({ method: "PATCH" })
    );
    expect(err).toBeUndefined();
  });

  it("propagates an error thrown by load unchanged", async () => {
    const err = await run(
      guardArchived(async () => {
        throw new NotFoundError("nope");
      }),
      req({ method: "PATCH" })
    );
    expect(err).toBeInstanceOf(NotFoundError);
  });

  it("with allow:()=>false blocks even a GET (per-route USAGE 2)", async () => {
    const err = await run(
      guardArchived(async () => archived, { allow: () => false }),
      req({ method: "GET" })
    );
    expect(err).toBeInstanceOf(ArchivedError);
  });

  it("honors a custom onArchived", async () => {
    const err = await run(
      guardArchived(async () => archived, {
        allow: () => false,
        onArchived: () => new ForbiddenError("owned by another org"),
      }),
      req({ method: "PATCH" })
    );
    expect(err).toBeInstanceOf(ForbiddenError);
  });
});

describe("guardArchivedById", () => {
  const uuid = "11111111-1111-4111-8111-111111111111";
  const archived = { archivedAt: new Date("2026-01-01") };

  it("extracts + validates the uuid param and passes it to loadById", async () => {
    let seen: string | undefined;
    const err = await run(
      guardArchivedById(async (id) => {
        seen = id;
        return archived;
      }),
      req({ method: "PATCH", params: { id: uuid } as Request["params"] })
    );
    expect(seen).toBe(uuid);
    expect(err).toBeInstanceOf(ArchivedError);
  });

  it("400s on a malformed id before loadById runs", async () => {
    const loadById = vi.fn(async () => archived);
    const err = await run(
      guardArchivedById(loadById),
      req({
        method: "PATCH",
        params: { id: "not-a-uuid" } as Request["params"],
      })
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect(loadById).not.toHaveBeenCalled();
  });

  it("reads a custom param name", async () => {
    let seen: string | undefined;
    await run(
      guardArchivedById(
        async (id) => {
          seen = id;
          return archived;
        },
        { param: "versionId" }
      ),
      req({ method: "GET", params: { versionId: uuid } as Request["params"] })
    );
    expect(seen).toBe(uuid);
  });
});
