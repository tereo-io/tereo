import { hasPermission } from "../utils/permissions.js";
import { describe, expect, it } from "vitest";

describe("hasPermission", () => {
  it("climbs the read/write/archive/delete ladder", () => {
    expect(hasPermission(["objects.delete"], "objects.read")).toBe(true);
    expect(hasPermission(["objects.read"], "objects.write")).toBe(false);
  });

  it("does not imply an off-ladder permission from a ladder one", () => {
    expect(hasPermission(["webhooks.read"], "webhooks.emit")).toBe(false);
    expect(hasPermission(["webhooks.delete"], "webhooks.emit")).toBe(false);
    expect(hasPermission(["services.read"], "services.approve")).toBe(false);
  });

  it("grants an off-ladder permission to itself, its admin, or admin", () => {
    expect(hasPermission(["webhooks.emit"], "webhooks.emit")).toBe(true);
    expect(hasPermission(["webhooks.admin"], "webhooks.emit")).toBe(true);
    expect(hasPermission(["admin"], "services.approve")).toBe(true);
  });
});
