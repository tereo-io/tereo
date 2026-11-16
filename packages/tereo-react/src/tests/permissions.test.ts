import { hasPermission } from "../permissions.js";
import { describe, expect, it } from "vitest";

describe("hasPermission", () => {
  it("lets write cover read", () => {
    expect(hasPermission(["x.write"], "x.read")).toBe(true);
  });

  it("does not let read cover write", () => {
    expect(hasPermission(["x.read"], "x.write")).toBe(false);
  });

  it("lets a scoped admin cover nested permissions", () => {
    expect(hasPermission(["x.admin"], "x.y.delete")).toBe(true);
    expect(hasPermission(["x.admin"], "z.read")).toBe(false);
  });

  it("lets bare admin cover anything", () => {
    expect(hasPermission(["admin"], "anything.at.all")).toBe(true);
  });

  it("covers an off-ladder permission only by itself or an admin", () => {
    expect(hasPermission(["webhooks.emit"], "webhooks.emit")).toBe(true);
    expect(hasPermission(["webhooks.admin"], "webhooks.emit")).toBe(true);
    expect(hasPermission(["admin"], "webhooks.emit")).toBe(true);
    expect(hasPermission(["webhooks.write"], "webhooks.emit")).toBe(false);
  });

  it("accepts any one of an array", () => {
    expect(hasPermission(["a.read"], ["b.read", "a.read"])).toBe(true);
    expect(hasPermission(["a.read"], ["b.read", "c.read"])).toBe(false);
    expect(hasPermission(["a.read"], [])).toBe(false);
  });
});
