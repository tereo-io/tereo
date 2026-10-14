import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ObjectImagePreviewModal from "./ObjectImagePreviewModal";
import { renderWithProviders } from "@/test/render";
import { screen } from "@testing-library/react";
import { authMock } from "@/test/authMock";

vi.mock("@/lib/auth", async () =>
  (await import("@/test/authMock")).mockAuthModule()
);

const create = vi.fn(() => "blob:preview");
const revoke = vi.fn();

beforeEach(() => {
  create.mockClear();
  revoke.mockClear();
  vi.stubGlobal(
    "URL",
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke })
  );
  authMock.axios.get.mockResolvedValue({ data: new Blob(["png"]) });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ObjectImagePreviewModal", () => {
  it("revokes the image's object URL when it closes", async () => {
    const { unmount } = renderWithProviders(
      <ObjectImagePreviewModal
        bucketName="b"
        objectKey="photos/cat.png"
        onClose={() => {}}
      />
    );
    expect(await screen.findByAltText("cat.png")).toHaveAttribute(
      "src",
      "blob:preview"
    );
    expect(revoke).not.toHaveBeenCalled();

    unmount();
    expect(revoke).toHaveBeenCalledWith("blob:preview");
    expect(revoke).toHaveBeenCalledTimes(create.mock.calls.length);
  });
});
