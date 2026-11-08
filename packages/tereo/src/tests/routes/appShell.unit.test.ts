// @module-tag unit
// @module-tag platform
import type { EffectiveBranding } from "../../utils/branding/merge.js";
import type { NextFunction, Request, Response } from "express";
import { createAppShell } from "../../routes/appShell.js";
import { describe, expect, it, vi } from "vitest";

const STOCK =
  "<!doctype html><html><head><title>Tereo</title></head><body></body></html>";

const BRANDED = { appName: "Acme", colorsLight: {}, colorsDark: {} };

const fakeReq = (path: string, query: Record<string, unknown> = {}) =>
  ({
    method: "GET",
    path,
    query,
    accepts: () => "html",
  }) as unknown as Request;

const fakeRes = () => {
  const res = {
    headers: {} as Record<string, string>,
    body: undefined as string | undefined,
    setHeader(name: string, value: string) {
      res.headers[name.toLowerCase()] = value;
      return res;
    },
    send(body: string) {
      res.body = body;
      return res;
    },
  };
  return res;
};

const run = async (
  resolvers: Parameters<typeof createAppShell>[0]["resolvers"],
  req: Request
) => {
  const res = fakeRes();
  const next = vi.fn() as unknown as NextFunction;
  await createAppShell({ indexHtml: STOCK, resolvers })(
    req,
    res as unknown as Response,
    next
  );
  return { res, next };
};

const failing = async (): Promise<EffectiveBranding | null> => {
  throw new Error("database is down");
};

describe("createAppShell", () => {
  it("serves the stock shell when resolving the client's branding throws", async () => {
    const { res, next } = await run(
      { auth: failing, console: failing },
      fakeReq("/login", { client_id: "acme" })
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.body).toBe(STOCK);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  it("serves the stock shell when resolving the console's branding throws", async () => {
    const { res } = await run(
      { auth: failing, console: failing },
      fakeReq("/auth-admin/users")
    );
    expect(res.body).toBe(STOCK);
  });

  it("passes the raw client_id to the auth resolver", async () => {
    const auth = vi.fn(async () => null);
    await run(
      { auth, console: failing },
      fakeReq("/login/2fa", { client_id: ["a", "b"] })
    );
    expect(auth).toHaveBeenCalledWith(["a", "b"]);
  });

  it("injects console branding only when it applies to the console", async () => {
    const off = await run(
      {
        auth: failing,
        console: async () =>
          ({ ...BRANDED, applyToConsole: false }) as EffectiveBranding,
      },
      fakeReq("/auth-admin/users")
    );
    expect(off.res.body).toBe(STOCK);

    const on = await run(
      {
        auth: failing,
        console: async () =>
          ({ ...BRANDED, applyToConsole: true }) as EffectiveBranding,
      },
      fakeReq("/auth-admin/users")
    );
    expect(on.res.body).toContain('"scope":"console"');
    expect(on.res.body).toContain("<title>Acme</title>");
  });
});
