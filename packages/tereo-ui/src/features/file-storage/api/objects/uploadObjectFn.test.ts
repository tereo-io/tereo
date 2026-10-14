import { retryWithBackoff } from "./retryWithBackoff";
import { describe, expect, it, vi } from "vitest";
import { uploadObjectFn } from "./uploadObjectFn";
import type { AxiosInstance } from "axios";

const fakeAxios = () => {
  const put = vi.fn().mockResolvedValue({ data: { id: "o" } });
  return { put, axios: { put } as unknown as AxiosInstance };
};

const upload = (axios: AxiosInstance, over: Record<string, unknown>) =>
  uploadObjectFn(axios, {
    bucketName: "b",
    objectKey: "k",
    file: new File(["x"], "k"),
    ...over,
  } as never);

describe("uploadObjectFn headers", () => {
  it("sends metadata as ASCII JSON that parses back unchanged", async () => {
    const { put, axios } = fakeAxios();
    const metadata = { name: "日本語😀" };
    await upload(axios, { metadata });
    const header = put.mock.calls[0][2].headers["X-Metadata"] as string;
    expect(header).toMatch(/^[\x20-\x7e]+$/);
    expect(JSON.parse(header)).toEqual(metadata);
  });

  it("sends tags as an ASCII JSON array, commas and all", async () => {
    const { put, axios } = fakeAxios();
    await upload(axios, { tags: [" ok ", "", "日本語", "a,b"] });
    const header = put.mock.calls[0][2].headers["X-Tags"] as string;
    expect(header).toMatch(/^\[[\x20-\x7e]+$/);
    expect(JSON.parse(header)).toEqual(["ok", "日本語", "a,b"]);
  });

  it("refuses tags core would refuse without sending", async () => {
    const { put, axios } = fakeAxios();
    await expect(upload(axios, { tags: ["x".repeat(129)] })).rejects.toThrow(
      /at most 128/
    );
    expect(put).not.toHaveBeenCalled();
  });
});

describe("retryWithBackoff", () => {
  it("does not retry a programming error", async () => {
    const fn = vi.fn().mockRejectedValue(new TypeError("x is undefined"));
    await expect(retryWithBackoff(fn)).rejects.toThrow(TypeError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a network failure", async () => {
    vi.useFakeTimers();
    try {
      const fn = vi
        .fn()
        .mockRejectedValueOnce({ isAxiosError: true })
        .mockResolvedValue("done");
      const result = retryWithBackoff(fn);
      await vi.runAllTimersAsync();
      await expect(result).resolves.toBe("done");
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
