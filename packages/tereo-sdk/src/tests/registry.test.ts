import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { RegistryClient } from "../clients/registry.js";
import { RequestError } from "../utils/errors.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { declare } = vi.hoisted(() => ({ declare: vi.fn() }));

vi.mock("../handler.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../handler.js")>()),
  requests: { registry: { declare } },
}));

/** What tryHandleRequest throws for an HTTP failure. */
const httpError = (status: number | undefined, data?: unknown) =>
  new RequestError("REG_0001", "Failed", {
    metadata: { originalError: { status, data } },
  });

const accepted = {
  service: "product-service",
  applied: true,
  changed: true,
  access: [{ id: "a1", kind: "role", target: "file_user", status: "pending" }],
};

const fast = () => new RegistryClient({ baseDelayMs: 1, maxDelayMs: 2 });

// A block body: a function returned from beforeEach runs as cleanup.
beforeEach(() => {
  declare.mockReset();
});

describe("RegistryClient", () => {
  it("is not registered until core accepts, then reports the result", async () => {
    declare.mockResolvedValueOnce(accepted);
    const client = fast();
    expect(client.isRegistered()).toBe(false);

    await expect(client.register({})).resolves.toEqual(accepted);
    expect(client.isRegistered()).toBe(true);
    expect(client.getRegistration()).toEqual(accepted);
    await expect(client.whenRegistered()).resolves.toEqual(accepted);
  });

  it.each([
    ["core unreachable", undefined, undefined],
    ["a 5xx", 503, undefined],
    ["a 429", 429, undefined],
    ["a 401", 401, undefined],
    ["a role not registered yet", 422, { error: "invalid_requested_access" }],
  ])("retries %s", async (_, status, data) => {
    declare
      .mockRejectedValueOnce(httpError(status, data))
      .mockRejectedValueOnce(httpError(status, data))
      .mockResolvedValueOnce(accepted);
    await expect(fast().register({})).resolves.toEqual(accepted);
    expect(declare).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["an invalid declaration", 422, { error: "invalid_declaration" }],
    ["an un-prefixed role name", 400, { error: "invalid_role_name" }],
    ["names another service owns", 409, { error: "conflict" }],
    ["a caller that is not a service", 403, { error: "forbidden" }],
  ])("gives up at once on %s", async (_, status, data) => {
    const error = httpError(status, data);
    declare.mockImplementation(async () => {
      throw error;
    });
    const client = fast();
    await expect(client.register({})).rejects.toBe(error);
    expect(declare).toHaveBeenCalledTimes(1);
    expect(client.isRegistered()).toBe(false);
  });

  it("stops retrying when closed", async () => {
    const error = httpError(503);
    declare.mockImplementation(async () => {
      throw error;
    });
    const client = new RegistryClient({ baseDelayMs: 50, maxDelayMs: 50 });
    const pending = client.register({});
    await vi.waitFor(() => expect(declare).toHaveBeenCalled());
    client.close();
    await expect(pending).rejects.toThrow(/aborted/);
  });

  it("stops an earlier registration's retries when registering again", async () => {
    declare.mockImplementation(async () => {
      throw httpError(undefined);
    });
    const client = fast();
    const first = client.register({ version: "1.0.0" });
    await vi.waitFor(() => expect(declare).toHaveBeenCalled());
    const second = client.register({ version: "1.0.1" });
    await expect(first).rejects.toThrow(/aborted/);

    client.close();
    await expect(second).rejects.toThrow(/aborted/);
    const calls = declare.mock.calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(declare).toHaveBeenCalledTimes(calls);
  });

  it("keeps the later registration's result when an earlier one answers last", async () => {
    let answerFirst!: (value: unknown) => void;
    declare
      .mockImplementationOnce(() => new Promise((r) => (answerFirst = r)))
      .mockResolvedValueOnce(accepted);
    const client = fast();
    const first = client.register({ version: "1.0.0" });
    await vi.waitFor(() => expect(declare).toHaveBeenCalled());
    await expect(client.register({ version: "1.0.1" })).resolves.toEqual(
      accepted
    );

    answerFirst({ ...accepted, changed: false });
    await expect(first).rejects.toThrow(/aborted/);
    expect(client.getRegistration()).toEqual(accepted);
  });

  it("whenRegistered rejects before register is called", async () => {
    await expect(fast().whenRegistered()).rejects.toThrow(/not been called/);
  });
});

describe("the declaration's version", () => {
  const cwd = process.cwd();
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tereo-sdk-version-"));
    process.chdir(dir);
    vi.stubEnv("npm_package_version", "");
    declare.mockResolvedValue(accepted);
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  const sentVersion = () => declare.mock.calls[0][0].version;

  it("defaults to the version in ./package.json", async () => {
    writeFileSync("package.json", JSON.stringify({ version: "2.3.4" }));
    await fast().register({});
    expect(sentVersion()).toBe("2.3.4");
  });

  it("prefers npm_package_version when npm set it", async () => {
    writeFileSync("package.json", JSON.stringify({ version: "2.3.4" }));
    vi.stubEnv("npm_package_version", "2.4.0-rc.1");
    await fast().register({});
    expect(sentVersion()).toBe("2.4.0-rc.1");
  });

  it("takes the one the declaration gives", async () => {
    writeFileSync("package.json", JSON.stringify({ version: "2.3.4" }));
    await fast().register({ version: "9.0.0" });
    expect(sentVersion()).toBe("9.0.0");
  });

  it("rejects without calling core when there is none", async () => {
    const client = fast();
    await expect(client.register({})).rejects.toThrow(/needs a version/);
    expect(declare).not.toHaveBeenCalled();
  });
});
