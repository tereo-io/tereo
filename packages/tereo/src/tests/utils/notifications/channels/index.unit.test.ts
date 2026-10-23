// @module-tag unit
// @module-tag notifications
import { emailAdapter } from "../../../../utils/notifications/channels/email.js";
import { describe, it, expect } from "vitest";
import {
  getAdapter,
  CHANNELS,
} from "../../../../utils/notifications/channels/index.js";

describe("CHANNELS and getAdapter", () => {
  it("lists email and returns its adapter", () => {
    expect(CHANNELS).toEqual(["email"]);
    expect(getAdapter("email")).toBe(emailAdapter);
    expect(emailAdapter.maxAttachmentBytes).toBe(20 * 1024 * 1024);
  });
});
