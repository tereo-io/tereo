/**
 * True when `address` equals an allowed entry, or its domain equals an
 * `@domain` entry. Entries are compared case-insensitively; a domain entry
 * does not cover subdomains.
 */
export function isAllowedSender(address: string, allowed: string[]): boolean {
  const addr = address.trim().toLowerCase();
  const at = addr.lastIndexOf("@");
  if (at < 1) return false;
  const domain = addr.slice(at);
  return allowed.some((entry) => {
    const e = entry.trim().toLowerCase();
    return e === addr || (e.startsWith("@") && e === domain);
  });
}
