import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import useDownloadObject from "./useDownloadObject";
import { authMock } from "@/test/authMock";

vi.mock("@/lib/auth", async () =>
  (await import("@/test/authMock")).mockAuthModule()
);

const signed =
  "http://core.test/v1/files/signed/objects/b/by-id/o1?op=read&sig=s";
let clicked: string[];

beforeEach(() => {
  clicked = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement
  ) {
    clicked.push(this.href);
  });
  authMock.axios.get.mockReset();
  authMock.axios.post.mockReset();
  authMock.axios.post.mockResolvedValue({ data: { url: signed } });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useDownloadObject", () => {
  it("navigates to a presigned attachment URL instead of fetching the bytes", async () => {
    const { result } = renderHook(() => useDownloadObject());
    await result.current.downloadObject("b", "o1");

    expect(authMock.axios.post).toHaveBeenCalledWith(
      "/buckets/b/objects/by-id/o1/presign",
      expect.objectContaining({ operation: "read" })
    );
    expect(authMock.axios.get).not.toHaveBeenCalled();
    expect(clicked).toHaveLength(1);
    const url = new URL(clicked[0]);
    expect(url.searchParams.get("sig")).toBe("s");
    expect(url.searchParams.get("disposition")).toBe("attachment");
  });
});
