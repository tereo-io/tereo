// @module-tag unit
// @module-tag webhooks
// @module-tag security
import { describe, it, expect, vi, afterEach } from "vitest";
import dns from "dns/promises";
import {
  BlockedAddressError,
  assertExternalTargetSafe,
  assertSafeWebhookUrlForRegistration,
  isPrivateOrReservedIp,
  parseInternalHost,
} from "../../utils/ssrfGuard.js";

describe("isPrivateOrReservedIp", () => {
  it.each([
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.8",
    "192.168.1.1",
    "198.18.0.1",
    "203.0.113.5",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:a9fe:a9fe",
    "64:ff9b::a9fe:a9fe",
    // Local-use NAT64 (RFC 8215): translated by the operator's own gateway.
    "64:ff9b:1::a9fe:a9fe",
    "64:ff9b:1:ffff::808:808",
    "2002:7f00:1::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "fe80::1%eth0",
    "ff02::1",
    "2001:db8::1",
    "3fff::1",
    "2001:2::1",
    // IPv4-translated (SIIT, RFC 6052 / 7915) form of 127.0.0.1.
    "::ffff:0:7f00:1",
    // Teredo: server 65.54.227.120, obfuscated client 127.0.0.1.
    "2001:0:4136:e378:8000:63bf:80ff:fffe",
    "2001:1::1",
    "not-an-ip",
  ])("blocks %s", (ip) => {
    expect(isPrivateOrReservedIp(ip)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "172.32.0.1",
    "100.128.0.1",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808",
    "2002:808:808::1",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
    "2001:200::1",
  ])("allows %s", (ip) => {
    expect(isPrivateOrReservedIp(ip)).toBe(false);
  });
});

describe("assertSafeWebhookUrlForRegistration", () => {
  const codeOf = (url: string) => {
    try {
      assertSafeWebhookUrlForRegistration(url);
      return null;
    } catch (err) {
      return (err as { code: string }).code;
    }
  };

  it("accepts public http(s) URLs and names it cannot resolve yet", () => {
    expect(codeOf("https://example.com/hook")).toBeNull();
    expect(codeOf("http://8.8.8.8:8080/hook")).toBeNull();
    expect(codeOf("https://[2606:4700:4700::1111]/hook")).toBeNull();
    expect(codeOf("https://not-yet-registered.example/hook")).toBeNull();
  });

  it("refuses private IPv4 and bracketed IPv6 literals", () => {
    expect(codeOf("http://127.0.0.1/")).toBe("private_url_not_allowed");
    expect(codeOf("http://2130706433/")).toBe("private_url_not_allowed");
    expect(codeOf("http://[::1]/")).toBe("private_url_not_allowed");
    expect(codeOf("http://[::ffff:169.254.169.254]/")).toBe(
      "private_url_not_allowed"
    );
    expect(codeOf("http://[fd00::1]:8080/")).toBe("private_url_not_allowed");
  });

  it("refuses localhost names", () => {
    expect(codeOf("http://localhost:4001/")).toBe("private_url_not_allowed");
    expect(codeOf("http://api.localhost/")).toBe("private_url_not_allowed");
    expect(codeOf("http://LOCALHOST./")).toBe("private_url_not_allowed");
  });

  it("refuses credentials in the URL, which fetch would reject", () => {
    expect(codeOf("https://user:pass@example.com/")).toBe("invalid_url");
  });

  it("refuses other schemes", () => {
    expect(codeOf("ftp://example.com/")).toBe("invalid_url");
    expect(codeOf("file:///etc/passwd")).toBe("invalid_url");
  });
});

describe("assertExternalTargetSafe", () => {
  it("refuses literal private addresses, IPv6 included", async () => {
    await expect(assertExternalTargetSafe("http://127.0.0.1/")).rejects.toThrow(
      /private\/internal/
    );
    await expect(assertExternalTargetSafe("http://[::1]/")).rejects.toThrow(
      /private\/internal address ::1/
    );
  });

  it("refuses a name that resolves to a private address", async () => {
    await expect(assertExternalTargetSafe("http://localhost/")).rejects.toThrow(
      /private\/internal/
    );
  });

  it("pins a public IPv6 literal without a DNS lookup", async () => {
    const agent = await assertExternalTargetSafe(
      "https://[2606:4700:4700::1111]/"
    );
    await agent.close();
  });
});

describe("parseInternalHost", () => {
  it.each([
    [
      "order-routing.vanquished.svc.cluster.local",
      "hostname",
      "order-routing.vanquished.svc.cluster.local",
    ],
    [
      "Order-Routing.Vanquished.svc.cluster.local.",
      "hostname",
      "order-routing.vanquished.svc.cluster.local",
    ],
    ["10.35.2.2", "ip", "10.35.2.2"],
    ["fd00::5", "ip", "fd00::5"],
    ["FD00:0:0::5", "ip", "fd00::5"],
  ])("accepts %s", (value, kind, host) => {
    expect(parseInternalHost(value)).toEqual({ kind, host });
  });

  it.each([
    "10.35.2.2/24",
    "http://x",
    "x:8080",
    "x/path",
    "user@x",
    "127.0.0.1",
    "LOCALHOST",
    "localhost.",
    "api.localhost",
    "[::1]",
    "::1",
    "::ffff:127.0.0.1",
    "127.1",
    "0x7f000001",
    "2130706433",
    "169.254.169.254",
    "fe80::1",
    "0.0.0.0",
    "::",
    "224.0.0.1",
    "ff02::1",
    "",
    " ",
    "bad host",
  ])("refuses %j", (value) => {
    expect(() => parseInternalHost(value)).toThrow(
      expect.objectContaining({ code: "invalid_internal_host" })
    );
  });
});

describe("allowPrivateHost", () => {
  it("lets the named host reach a private address at delivery", async () => {
    const agent = await assertExternalTargetSafe("http://10.35.2.2/x", {
      allowPrivateHost: "10.35.2.2",
    });
    await agent.close();
  });

  it("keeps the full guard without it, or for another host", async () => {
    await expect(
      assertExternalTargetSafe("http://10.35.2.2/x")
    ).rejects.toBeInstanceOf(BlockedAddressError);
    await expect(
      assertExternalTargetSafe("http://10.35.2.2/x", {
        allowPrivateHost: "10.35.2.3",
      })
    ).rejects.toBeInstanceOf(BlockedAddressError);
  });

  it("matches a normalized IPv6 literal", async () => {
    const agent = await assertExternalTargetSafe("http://[fd00:0::5]:8080/x", {
      allowPrivateHost: "fd00::5",
    });
    await agent.close();
  });

  it("still refuses loopback, link-local, unspecified and multicast", async () => {
    for (const host of ["127.0.0.1", "169.254.169.254", "0.0.0.0", "224.0.0.1"])
      await expect(
        assertExternalTargetSafe(`http://${host}/x`, { allowPrivateHost: host })
      ).rejects.toBeInstanceOf(BlockedAddressError);
    await expect(
      assertExternalTargetSafe("http://[::1]/x", { allowPrivateHost: "::1" })
    ).rejects.toBeInstanceOf(BlockedAddressError);
  });

  it("still refuses a name that resolves to loopback", async () => {
    await expect(
      assertExternalTargetSafe("http://localhost/x", {
        allowPrivateHost: "localhost",
      })
    ).rejects.toBeInstanceOf(BlockedAddressError);
  });

  describe("a named host's DNS answers", () => {
    const resolveTo = (...addresses: string[]) =>
      vi.spyOn(dns, "lookup").mockResolvedValue(
        addresses.map((address) => ({
          address,
          family: address.includes(":") ? 6 : 4,
        })) as never
      );
    const deliver = () =>
      assertExternalTargetSafe("http://svc.internal:8080/x", {
        allowPrivateHost: "svc.internal",
      });

    afterEach(() => vi.restoreAllMocks());

    it.each(["127.0.0.1", "169.254.169.254", "::ffff:127.0.0.1"])(
      "refuses one resolving to %s",
      async (address) => {
        resolveTo(address);
        await expect(deliver()).rejects.toBeInstanceOf(BlockedAddressError);
      }
    );

    it("refuses mixed records with one loopback address", async () => {
      resolveTo("10.35.2.2", "127.0.0.1");
      await expect(deliver()).rejects.toBeInstanceOf(BlockedAddressError);
    });

    it("accepts a private address", async () => {
      resolveTo("10.35.2.2");
      const agent = await deliver();
      await agent.close();
    });
  });

  it("lets the named host pass registration as a private literal, nothing else", () => {
    expect(() =>
      assertSafeWebhookUrlForRegistration("http://10.35.2.2:8080/hook", {
        allowPrivateHost: "10.35.2.2",
      })
    ).not.toThrow();
    expect(() =>
      assertSafeWebhookUrlForRegistration("http://10.35.2.3:8080/hook", {
        allowPrivateHost: "10.35.2.2",
      })
    ).toThrow(expect.objectContaining({ code: "private_url_not_allowed" }));
    expect(() =>
      assertSafeWebhookUrlForRegistration("http://127.0.0.1/hook", {
        allowPrivateHost: "127.0.0.1",
      })
    ).toThrow(expect.objectContaining({ code: "private_url_not_allowed" }));
    expect(() =>
      assertSafeWebhookUrlForRegistration("http://localhost/hook", {
        allowPrivateHost: "localhost",
      })
    ).toThrow(expect.objectContaining({ code: "private_url_not_allowed" }));
  });
});
