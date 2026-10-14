import { ipRateLimitKey } from "../../utils/rateLimit.js";
import { describe, it, expect } from "vitest";

describe("ipRateLimitKey", () => {
  it("counts every address of an IPv6 /64 as one", () => {
    expect(ipRateLimitKey("2001:db8:1:2:aaaa::1")).toBe(
      ipRateLimitKey("2001:db8:1:2:bbbb::2")
    );
    expect(ipRateLimitKey("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(ipRateLimitKey("2001:0db8:0001:0002:ffff:ffff:ffff:ffff")).toBe(
      "2001:db8:1:2::/64"
    );
    expect(ipRateLimitKey("::1")).toBe("0:0:0:0::/64");
  });

  it("keeps different /64s apart", () => {
    expect(ipRateLimitKey("2001:db8:1:2::1")).not.toBe(
      ipRateLimitKey("2001:db8:1:3::1")
    );
  });

  it("unwraps IPv4-mapped IPv6", () => {
    expect(ipRateLimitKey("::ffff:1.2.3.4")).toBe("1.2.3.4");
    expect(ipRateLimitKey("::FFFF:102:304")).toBe("1.2.3.4");
  });

  it("leaves IPv4 and non-addresses unchanged", () => {
    expect(ipRateLimitKey("1.2.3.4")).toBe("1.2.3.4");
    expect(ipRateLimitKey("unknown")).toBe("unknown");
  });
});
