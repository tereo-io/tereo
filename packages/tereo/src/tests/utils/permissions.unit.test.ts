// @module-tag unit
// @module-tag auth
import { hasPermission } from "../../utils/permissions.js";
import { describe, it, expect } from "vitest";

describe("hasPermission", () => {
  it("grants an action outside the ladder only by itself or an admin", () => {
    expect(hasPermission(["webhooks.read"], "webhooks.emit")).toBe(false);
    expect(hasPermission(["webhooks.delete"], "webhooks.emit")).toBe(false);
    expect(hasPermission(["webhooks.emit"], "webhooks.emit")).toBe(true);
    expect(hasPermission(["webhooks.admin"], "webhooks.emit")).toBe(true);
    expect(hasPermission(["services.read"], "services.approve")).toBe(false);
    expect(hasPermission(["webhooks.emit"], "webhooks.read")).toBe(false);
  });

  it("grants users.reports.write by users.admin, not by users.write", () => {
    expect(hasPermission(["users.write"], "users.reports.write")).toBe(false);
    expect(hasPermission(["users.admin"], "users.reports.write")).toBe(true);
  });
});
