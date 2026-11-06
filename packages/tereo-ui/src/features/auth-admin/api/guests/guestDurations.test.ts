import { describe, expect, it } from "vitest";
import {
  CAP_MARGIN_SECONDS,
  DAY_SECONDS,
  defaultDuration,
  expiryAfter,
  guestDurationOptions,
} from "./guestDurations";

describe("guestDurationOptions", () => {
  it("offers 7, 30 and 90 days while the cap is unknown", () => {
    expect(guestDurationOptions(undefined).map((o) => o.label)).toEqual([
      "7 days",
      "30 days",
      "90 days",
    ]);
  });

  it("keeps an option exactly at the cap", () => {
    expect(
      guestDurationOptions(90 * DAY_SECONDS).map((o) => Number(o.value))
    ).toEqual([7, 30, 90].map((d) => d * DAY_SECONDS));
  });

  it("offers the cap alone when it is under all of them, in hours when not whole days", () => {
    expect(guestDurationOptions(12 * 3600)).toEqual([
      { value: String(12 * 3600), label: "12 hours" },
    ]);
  });

  it("defaults to 30 days, or the longest when 30 is not offered", () => {
    expect(defaultDuration(guestDurationOptions(undefined))).toBe(
      String(30 * DAY_SECONDS)
    );
    expect(defaultDuration(guestDurationOptions(20 * DAY_SECONDS))).toBe(
      String(7 * DAY_SECONDS)
    );
  });
});

describe("expiryAfter", () => {
  const now = Date.UTC(2026, 10, 6);

  it("is now plus the duration below the cap", () => {
    expect(expiryAfter(7 * DAY_SECONDS, 30 * DAY_SECONDS, now).getTime()).toBe(
      now + 7 * DAY_SECONDS * 1000
    );
  });

  it("stops the margin short of the cap", () => {
    expect(expiryAfter(30 * DAY_SECONDS, 30 * DAY_SECONDS, now).getTime()).toBe(
      now + (30 * DAY_SECONDS - CAP_MARGIN_SECONDS) * 1000
    );
  });

  it("keeps a short cap's margin within a tenth of it", () => {
    expect(expiryAfter(600, 600, now).getTime()).toBe(now + 540 * 1000);
  });
});
