import { BadRequestError } from "./errors.js";
import type { LookupAddress } from "node:dns";
import { Agent } from "undici";
import dns from "dns/promises";
import net from "net";

// SSRF guard for outbound webhook delivery.
//
// Tenant-registered endpoints (POST /v1/webhooks) are fully attacker-controlled
// URLs that the delivery worker fetches. Without a guard, a caller could point
// one at cloud metadata (169.254.169.254), localhost, or an internal platform
// service and read the response back through the deliveries API. We defend in
// two layers:
//
//   1. Registration time (assertSafeWebhookUrlForRegistration): structural
//      checks only, NO DNS — reject any URL that isn't http/https, carries
//      credentials, names localhost, or whose host is a private/reserved IP
//      literal. We deliberately don't resolve hostnames here: a registration
//      shouldn't depend on DNS egress or on the host being resolvable yet, and
//      the authoritative check happens at delivery anyway.
//   2. Delivery time (assertExternalTargetSafe): resolve the host, reject any
//      private/reserved result, and return a dispatcher pinned to the
//      validated IPs. The caller must fetch through it so the socket lands on
//      the checked IP rather than a second, rebindable DNS lookup. The worker
//      also never follows redirects, so a 3xx can't bounce it internal.
//
// One exception (`allowPrivateHost`): a service's own provisioned endpoints
// may reach its declared internalHost at a private address, in both layers.
// Unspecified, loopback, link-local and multicast addresses stay refused even
// then, whether written in the URL or resolved from it.

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

// Special-purpose ranges (RFC 6890 and successors) an outbound webhook has no
// business reaching: private, loopback, link-local (incl. cloud metadata),
// CGNAT, documentation, benchmarking, multicast and reserved.
const BLOCKED_RANGES = new net.BlockList();
// Unspecified, loopback, link-local and multicast/reserved: refused even for
// a service's own internalHost.
const ALWAYS_BLOCKED_V4: [string, number][] = [
  ["0.0.0.0", 8],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["224.0.0.0", 3],
];
const BLOCKED_V4: [string, number][] = [
  ...ALWAYS_BLOCKED_V4,
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
];
// The IPv6 counterparts, plus translation and tunnel ranges whose embedded
// IPv4 address cannot be checked here.
const ALWAYS_BLOCKED_V6: [string, number][] = [
  ["::", 96], // unspecified, loopback, IPv4-compatible
  ["::ffff:0:0:0", 96], // IPv4-translated (SIIT)
  // Local-use NAT64 (RFC 8215): the operator's own translator, which may map
  // the embedded IPv4 address anywhere, private ranges included.
  ["64:ff9b:1::", 48],
  ["2001::", 32], // Teredo, which embeds an obfuscated IPv4 client address
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
];
const BLOCKED_V6: [string, number][] = [
  ...ALWAYS_BLOCKED_V6,
  ["100::", 64], // discard
  // IETF protocol assignments: benchmarking, ORCHID and anycast service
  // addresses.
  ["2001::", 23],
  ["2001:db8::", 32], // documentation
  ["3fff::", 20], // documentation
  ["fc00::", 7], // unique-local
  ["fec0::", 10], // site-local
];
const ALWAYS_BLOCKED_RANGES = new net.BlockList();
for (const [address, prefix] of BLOCKED_V4) {
  BLOCKED_RANGES.addSubnet(address, prefix, "ipv4");
}
for (const [address, prefix] of BLOCKED_V6) {
  BLOCKED_RANGES.addSubnet(address, prefix, "ipv6");
}
for (const [address, prefix] of ALWAYS_BLOCKED_V4) {
  ALWAYS_BLOCKED_RANGES.addSubnet(address, prefix, "ipv4");
}
for (const [address, prefix] of ALWAYS_BLOCKED_V6) {
  ALWAYS_BLOCKED_RANGES.addSubnet(address, prefix, "ipv6");
}

/** The eight 16-bit groups of a valid IPv6 address without a zone id. */
function ipv6Groups(ip: string): number[] {
  let addr = ip.toLowerCase();
  const dotted = addr.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(2).map(Number);
    addr = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  if (!addr.includes("::")) return addr.split(":").map((g) => parseInt(g, 16));
  const [head, tail] = addr.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const zeros = Array<string>(8 - h.length - t.length).fill("0");
  return [...h, ...zeros, ...t].map((g) => parseInt(g, 16));
}

const v4FromGroups = (hi: number, lo: number): string =>
  [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join(".");

/**
 * The IPv4 address an IPv6 address carries through NAT64 (64:ff9b::/96) or
 * 6to4 (2002::/16), or null. BlockList already matches IPv4-mapped addresses
 * (::ffff:0:0/96) against the IPv4 rules.
 */
function embeddedV4(ip: string): string | null {
  const g = ipv6Groups(ip);
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0))
    return v4FromGroups(g[6], g[7]);
  if (g[0] === 0x2002) return v4FromGroups(g[1], g[2]);
  return null;
}

/** `ip` in `ranges`, directly or through an embedded IPv4 address. */
const inRanges = (ranges: net.BlockList, ip: string): boolean => {
  const family = net.isIP(ip);
  if (family === 4) return ranges.check(ip, "ipv4");
  if (family !== 6) return true;
  const addr = ip.replace(/%.*$/, "");
  if (ranges.check(addr, "ipv6")) return true;
  const v4 = embeddedV4(addr);
  return v4 !== null && ranges.check(v4, "ipv4");
};

/**
 * True for an address in a special-purpose range, including one reached
 * through an IPv4-mapped, NAT64 or 6to4 IPv6 address. Anything that isn't an
 * IP address is treated as unsafe.
 */
export function isPrivateOrReservedIp(ip: string): boolean {
  return inRanges(BLOCKED_RANGES, ip);
}

/**
 * True for an unspecified, loopback, link-local or multicast address (or one
 * reached through a translation range): never a webhook target, not even a
 * service's own internalHost. Anything that isn't an IP address is unsafe.
 */
export function isAlwaysBlockedIp(ip: string): boolean {
  return inRanges(ALWAYS_BLOCKED_RANGES, ip);
}

/** A URL's host as a name or bare address: IPv6 literals lose their brackets. */
const hostOf = (url: URL): string => url.hostname.replace(/^\[(.*)\]$/, "$1");

const isLocalhostName = (host: string): boolean => {
  const name = host.toLowerCase().replace(/\.$/, "");
  return name === "localhost" || name.endsWith(".localhost");
};

/** A URL's host as compared with an internalHost: no trailing dot. */
const comparableHost = (url: URL): string => hostOf(url).replace(/\.$/, "");

const HOSTNAME_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * A service's internalHost: a DNS hostname or a single IP literal its own
 * webhook endpoints may reach at a private address. Returns it normalized
 * (lowercase, no trailing dot, IPs in their canonical form). Throws
 * `invalid_internal_host` for anything else — a CIDR, a scheme, port or path,
 * a non-canonical IP spelling — and for a localhost name or an unspecified,
 * loopback, link-local or multicast address.
 */
export function parseInternalHost(value: string): {
  kind: "hostname" | "ip";
  host: string;
} {
  const invalid = (why: string): never => {
    throw new BadRequestError("invalid_internal_host", why);
  };
  const refuseAlwaysBlocked = (ip: string) => {
    if (isAlwaysBlockedIp(ip))
      invalid(
        "may not be an unspecified, loopback, link-local or multicast address"
      );
  };

  if (!value) return invalid("must not be empty");
  if (value.includes("/")) {
    return invalid(
      "must be a hostname or a single IP address, not a CIDR, URL or path"
    );
  }

  if (net.isIPv6(value)) {
    if (value.includes("%")) return invalid("may not carry an IPv6 zone id");
    // The URL parser writes an IPv6 address in its canonical, compressed form.
    const host = hostOf(new URL(`http://[${value}]`));
    refuseAlwaysBlocked(host);
    return { kind: "ip", host };
  }
  if (net.isIPv4(value)) {
    refuseAlwaysBlocked(value);
    return { kind: "ip", host: value };
  }

  const host = value.toLowerCase().replace(/\.$/, "");
  if (
    host.length > 253 ||
    !host.split(".").every((l) => HOSTNAME_LABEL.test(l))
  )
    return invalid(
      "must be a hostname or a single IP address, without a scheme, port or path"
    );
  // Shorthand and numeric IPv4 spellings (127.1, 0x7f000001, 2130706433) that
  // a URL would read as an address.
  let asUrlHost: string;
  try {
    asUrlHost = hostOf(new URL(`http://${host}`));
  } catch {
    return invalid("must be a valid hostname");
  }
  if (net.isIP(asUrlHost))
    return invalid("must write an IP address in its standard form");
  if (isLocalhostName(host)) return invalid("may not be a localhost name");
  return { kind: "hostname", host };
}

/** `allowPrivateHost` normalized, or null when it allows nothing. */
const allowedPrivateHost = (allowPrivateHost?: string): string | null => {
  if (!allowPrivateHost) return null;
  try {
    return parseInternalHost(allowPrivateHost).host;
  } catch {
    return null;
  }
};

export interface PrivateHostOption {
  /**
   * A service's internalHost: a URL whose host is exactly this may reach a
   * private or reserved address, still never an unspecified, loopback,
   * link-local or multicast one.
   */
  allowPrivateHost?: string;
}

/** A host resolved to, or written as, a private or reserved address. */
export class BlockedAddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedAddressError";
  }
}

/** A host that did not resolve to any address. */
export class UnresolvableHostError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "UnresolvableHostError";
  }
}

export interface ResolvedAddress {
  address: string;
  family: number; // 4 or 6
}

/**
 * Resolve a host to the addresses we will connect to, verifying every one is
 * public. Fails CLOSED — throws if the host doesn't resolve or any address is
 * private/reserved (an unresolvable external target has nowhere safe to go;
 * BullMQ retries). IP literals are checked directly.
 */
export async function resolveSafeAddresses(
  hostname: string,
  { allowPrivate = false }: { allowPrivate?: boolean } = {}
): Promise<ResolvedAddress[]> {
  const blocked = allowPrivate ? isAlwaysBlockedIp : isPrivateOrReservedIp;
  const literalFamily = net.isIP(hostname);
  if (literalFamily) {
    if (blocked(hostname)) {
      throw new BlockedAddressError(
        `Refusing to deliver to private/internal address ${hostname}`
      );
    }
    return [{ address: hostname, family: literalFamily }];
  }
  const records = await dns.lookup(hostname, { all: true }).catch((err) => {
    throw new UnresolvableHostError(`Host ${hostname} did not resolve`, {
      cause: err,
    });
  });
  if (records.length === 0) {
    throw new UnresolvableHostError(
      `Host ${hostname} did not resolve to any address`
    );
  }
  for (const r of records) {
    if (blocked(r.address)) {
      throw new BlockedAddressError(
        `Refusing to deliver to private/internal address ${r.address} for host ${hostname}`
      );
    }
  }
  return records.map((r) => ({ address: r.address, family: r.family }));
}

/**
 * An undici Agent whose connect step does no DNS — its lookup always returns the
 * pre-validated addresses, pinning the connection to the IPs we checked. The
 * hostname is still used for SNI/Host, so cert validation is unaffected. One
 * Agent per delivery; the caller closes it when the request settles.
 */
export function createPinnedDispatcher(addresses: ResolvedAddress[]): Agent {
  return new Agent({
    connect: {
      lookup(
        _hostname: string,
        options: { all?: boolean },
        callback: (
          err: NodeJS.ErrnoException | null,
          address: string | LookupAddress[],
          family?: number
        ) => void
      ): void {
        if (options.all) {
          callback(
            null,
            addresses.map((a) => ({ address: a.address, family: a.family }))
          );
        } else {
          callback(null, addresses[0].address, addresses[0].family);
        }
      },
    },
  });
}

/**
 * Registration-time guard for caller-supplied webhook URLs — structural checks
 * only, NO DNS (see file header). Throws BadRequestError if the URL is
 * statically unsafe or could never be delivered to. Call from the public
 * create/update endpoints.
 */
export function assertSafeWebhookUrlForRegistration(
  rawUrl: string,
  opts: PrivateHostOption = {}
): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BadRequestError("invalid_url", "Webhook URL is not a valid URL");
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new BadRequestError(
      "invalid_url",
      "Webhook URL must use http or https"
    );
  }

  // fetch refuses a URL with credentials, so every delivery would fail.
  if (url.username || url.password) {
    throw new BadRequestError(
      "invalid_url",
      "Webhook URL may not contain credentials; send them in a custom header"
    );
  }

  // Block private/reserved IP *literals* and localhost outright. Other names
  // are checked at delivery time (resolving here would couple registration to
  // DNS).
  const host = hostOf(url);
  const blocked =
    comparableHost(url) === allowedPrivateHost(opts.allowPrivateHost)
      ? isAlwaysBlockedIp
      : isPrivateOrReservedIp;
  if (isLocalhostName(host) || (net.isIP(host) && blocked(host))) {
    throw new BadRequestError(
      "private_url_not_allowed",
      "Webhook URL may not target a private or reserved address"
    );
  }
}

/**
 * Delivery-time guard. Resolves and validates the host and returns a
 * dispatcher pinned to the validated IPs; the caller must fetch through it
 * (and close it afterward) so the connection can't be rebound between this
 * check and the connect. Throws if the URL is non-http(s), unresolvable, or
 * resolves to a private/reserved address.
 */
export async function assertExternalTargetSafe(
  rawUrl: string,
  opts: PrivateHostOption = {}
): Promise<Agent> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Webhook URL is not a valid URL");
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new Error(`Refusing to deliver to non-http(s) URL: ${url.protocol}`);
  }
  const addresses = await resolveSafeAddresses(hostOf(url), {
    allowPrivate:
      comparableHost(url) === allowedPrivateHost(opts.allowPrivateHost),
  });
  return createPinnedDispatcher(addresses);
}
