import { describe, it, expect } from "vitest";
import {
  assertExternalTargetSafe,
  assertSafeWebhookUrlForRegistration,
  isPrivateOrReservedIp,
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
