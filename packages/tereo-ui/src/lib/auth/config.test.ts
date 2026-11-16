import { createCoreAuthConfig } from "@/lib/auth/config";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

describe("core's auth config", () => {
  const queryClient = new QueryClient();
  const config = createCoreAuthConfig(queryClient);

  it.each([
    ["/", true],
    ["/callback", true],
    ["/setup", true],
    ["/consent", true],
    ["/login", true],
    ["/logout", true],
    ["/set-password", true],
    ["/forgot-password", true],
    ["/verify-email", true],
    ["/shared/x", true],
    ["/users", false],
  ])("isPublicPath(%s) is %s", (path, expected) => {
    const open = path === config.signedOutPath || config.isPublicPath?.(path);
    expect(Boolean(open)).toBe(expected);
  });

  it("refreshes the session lists when one of the user's sessions is revoked", () => {
    const invalidate = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue();

    config.onEvent?.({
      type: "session-revoked",
      payload: { sessionId: "s1", timestamp: 1 },
    });

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["sessions"] });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["account", "sessions"],
    });
  });

  it("ignores other events", () => {
    const invalidate = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue();
    invalidate.mockClear();

    config.onEvent?.({
      type: "permissions",
      payload: { reason: "x", timestamp: 1 },
    });

    expect(invalidate).not.toHaveBeenCalled();
  });
});
