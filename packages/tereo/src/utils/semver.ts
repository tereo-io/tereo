/**
 * `MAJOR.MINOR.PATCH` with an optional `-prerelease`, as semver 2.0 spells
 * them: no leading zeros in numbers, dot-separated prerelease identifiers.
 * Build metadata (`+…`) is not accepted.
 */
const NUMBER = "(0|[1-9]\\d*)";
const IDENTIFIER = "(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)";
export const SEMVER_PATTERN = new RegExp(
  `^${NUMBER}\\.${NUMBER}\\.${NUMBER}(?:-(${IDENTIFIER}(?:\\.${IDENTIFIER})*))?$`
);

const parse = (version: string) => {
  const match = SEMVER_PATTERN.exec(version);
  if (!match) throw new Error(`Not a semver version: ${version}`);
  return {
    release: [match[1], match[2], match[3]].map(BigInt),
    prerelease: match[4]?.split(".") ?? [],
  };
};

const sign = (n: number) => (n < 0 ? -1 : n > 0 ? 1 : 0);

/** Semver precedence of two prerelease identifiers. */
const compareIdentifiers = (a: string, b: string): number => {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) return sign(Number(BigInt(a) - BigInt(b)));
  // Numeric identifiers sort before alphanumeric ones.
  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
};

/** -1, 0 or 1 as `a` precedes, equals or follows `b` in semver order. */
export const compareSemver = (a: string, b: string): number => {
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    if (x.release[i] !== y.release[i]) {
      return x.release[i] < y.release[i] ? -1 : 1;
    }
  }
  // A prerelease precedes its release.
  if (x.prerelease.length === 0 || y.prerelease.length === 0) {
    return sign(y.prerelease.length - x.prerelease.length);
  }
  const length = Math.min(x.prerelease.length, y.prerelease.length);
  for (let i = 0; i < length; i++) {
    const order = compareIdentifiers(x.prerelease[i], y.prerelease[i]);
    if (order !== 0) return order;
  }
  return sign(x.prerelease.length - y.prerelease.length);
};
