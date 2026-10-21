import {
  broadcastSigningKeysChanged,
  onSigningKeysChanged,
} from "./cacheBroadcast.js";
import { hasMasterKey, setMasterKey } from "./masterKeys.js";
import { ID_TOKEN_HINT_GRACE_SECONDS } from "./tokens.js";
import { prisma, type Prisma } from "./db/prisma.js";
import { ConflictError } from "./errors.js";
import { logger } from "./logger.js";
import jwt from "jsonwebtoken";
import env from "../env.js";
import {
  type KeyEncryptionKey,
  openSecret,
  resolveKek,
  resolvePreviousKek,
  sealSecret,
} from "./kek.js";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
} from "crypto";

/**
 * Core's keys: from env when supplied, otherwise generated on first start and
 * kept in `core.secrets`, each value encrypted with the KEK (utils/kek.ts).
 * Call `loadKeys()` before anything signs, verifies, encrypts or decrypts — it
 * fills the same `env` object every consumer reads, and the master-key
 * registry.
 *
 * An env value always wins and is never stored. Only the active version of a
 * versioned key is generated; every stored version is loaded, so material
 * from before a rotation keeps verifying and decrypting.
 *
 * JWT signing keys are versioned rows, `JWT_SIGNING_KEY_V{n}` (the private
 * PEM), whose `created_at` is when the version starts signing: a rotation
 * publishes the new key at once and activates it `ACTIVATION_DELAY_MS` later.
 * The highest activated version signs (`currentSigningKey()`); each older one
 * is retired when a later version activates and keeps verifying, and stays in
 * the JWKS, for one token lifetime plus the id_token_hint grace. An immediate
 * rotation deletes every older version instead. A key pair in env
 * (`JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY`) is the only key, and stored versions
 * are ignored.
 */

const base64Key = () => randomBytes(32).toString("base64");

const isBase64Key = (value: string) =>
  Buffer.from(value, "base64").length === 32;

const MASTER_KEY_PREFIX = "FILE_SERVICE_MASTER_KEY_V";
const JWT_KEY_PREFIX = "JWT_SIGNING_KEY_V";

const versionOf = (prefix: string, name: string): number | null => {
  if (!name.startsWith(prefix)) return null;
  const version = Number(name.slice(prefix.length));
  return Number.isInteger(version) && version > 0 ? version : null;
};

const masterKeyVersion = (name: string) => versionOf(MASTER_KEY_PREFIX, name);
const jwtKeyVersion = (name: string) => versionOf(JWT_KEY_PREFIX, name);

const fields = env as unknown as Record<string, unknown>;

const isPresent = (name: string): boolean => {
  const version = masterKeyVersion(name);
  if (version !== null) return hasMasterKey(version);
  const value = fields[name];
  return typeof value === "string" && value.length > 0;
};

const apply = (name: string, value: string) => {
  const version = masterKeyVersion(name);
  if (version !== null) setMasterKey(version, value, name);
  else fields[name] = value;
};

const MIN_RSA_MODULUS_BITS = 2048;

const generateRsaPrivateKey = (): string =>
  generateKeyPairSync("rsa", {
    modulusLength: MIN_RSA_MODULUS_BITS,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  }).privateKey;

interface KeySpec {
  name: string;
  generate: () => string;
  /** Checked against env-supplied and stored values alike. */
  valid: (value: string) => boolean;
}

const keySpecs = (): KeySpec[] => [
  {
    name: "TOTP_ENCRYPTION_KEY",
    generate: () => randomBytes(32).toString("hex"),
    valid: (key) => /^[0-9a-f]{64}$/i.test(key),
  },
  ...[
    `CURSOR_SIGNING_KEY_V${env.CURSOR_ACTIVE_SIGNING_KEY_VERSION}`,
    `FILE_SERVICE_SIGNING_KEY_V${env.FILE_SERVICE_ACTIVE_SIGNING_KEY_VERSION}`,
    `${MASTER_KEY_PREFIX}${env.FILE_SERVICE_ACTIVE_MASTER_KEY_VERSION}`,
    "AUTH_CODE_HMAC_KEY",
    "KNOWN_DEVICE_KEY",
  ].map((name) => ({ name, generate: base64Key, valid: isBase64Key })),
];

const valueOf = (name: string): string | undefined => {
  const value = fields[name];
  return typeof value === "string" ? value : undefined;
};

/** RFC 7638 thumbprint of the public key: a stable `kid` per key. */
const jwkThumbprint = (publicKeyPem: string): string => {
  const { e, kty, n } = createPublicKey(publicKeyPem).export({
    format: "jwk",
  });
  return createHash("sha256")
    .update(JSON.stringify({ e, kty, n }))
    .digest("base64url");
};

// ---------------------------------------------------------------------------
// Stored values
// ---------------------------------------------------------------------------

let kek: KeyEncryptionKey | null = null;

export const currentKek = (): KeyEncryptionKey => {
  kek ??= resolveKek(env);
  return kek;
};

export const previousKek = resolvePreviousKek(env);

interface StoredSecret {
  name: string;
  value: string;
  createdAt: Date;
}

/**
 * Decrypts the rows, and encrypts in place any stored under CORE_KEK_PREVIOUS
 * or, outside production, stored before the KEK or under the dev KEK. The update only applies while the row still holds what
 * was read, so processes starting together each try once and one wins; a
 * loser changes nothing, and all hold the same plaintext either way.
 */
const openRows = async (
  rows: { name: string; value: string; createdAt: Date }[]
): Promise<StoredSecret[]> => {
  const k = currentKek();
  const opened: StoredSecret[] = [];
  const rewrapped: string[] = [];
  for (const row of rows) {
    const { value, rewrap } = await openSecret(
      k,
      row.name,
      row.value,
      previousKek,
      env.NODE_ENV === "production"
    );
    if (rewrap) {
      const { count } = await prisma.secret.updateMany({
        where: { name: row.name, value: row.value },
        data: { value: await sealSecret(k, row.name, value) },
      });
      if (count > 0) rewrapped.push(row.name);
    }
    opened.push({ name: row.name, value, createdAt: row.createdAt });
  }
  if (rewrapped.length > 0) {
    logger.info(
      { keys: rewrapped, kek: k.id },
      "Encrypted stored keys in core.secrets with the KEK"
    );
  }
  return opened;
};

// ---------------------------------------------------------------------------
// JWT signing keys
// ---------------------------------------------------------------------------

interface SigningKey {
  kid: string;
  /** Null for a key pair supplied in env. */
  version: number | null;
  privateKey: string;
  publicKey: string;
  /** When it starts signing; null for a key pair supplied in env. */
  activatesAt: Date | null;
  retiredAt: Date | null;
}

let signingKeys: SigningKey[] = [];
let jwtKeysFromEnv = false;
let lastRefresh = 0;

/** How long a retired key keeps verifying and stays in the JWKS. */
const retentionMs = () =>
  (env.JWT_ACCESS_TOKEN_TTL + ID_TOKEN_HINT_GRACE_SECONDS) * 1000;

const isUsable = (key: SigningKey, now: number) =>
  key.retiredAt === null || key.retiredAt.getTime() + retentionMs() > now;

const useSigningKeys = (keys: SigningKey[]) => {
  if (keys.length === 0) throw new Error("No JWT signing key");
  signingKeys = keys;
};

/**
 * The key that signs now: the highest version that has activated. Chosen by
 * the clock on every call, so every process switches at the same moment.
 * The lowest version stands in until one has, should the database's clock
 * run ahead of this process's.
 */
export const currentSigningKey = (): {
  kid: string;
  privateKey: string;
  publicKey: string;
} => {
  if (signingKeys.length === 0) throw new Error("loadKeys() has not run");
  const { kid, privateKey, publicKey } = signingKeyAt(Date.now());
  return { kid, privateKey, publicKey };
};

/** The key that signs at `time`, by the keys known now. */
const signingKeyAt = (time: number): SigningKey => {
  const byVersion = [...signingKeys].sort(
    (a, b) => (b.version ?? 0) - (a.version ?? 0)
  );
  return (
    byVersion.find(
      (k) => k.activatesAt === null || k.activatesAt.getTime() <= time
    ) ?? byVersion[byVersion.length - 1]
  );
};

const toSigningKeys = (rows: StoredSecret[]): SigningKey[] => {
  const versions = rows
    .map((row) => ({ ...row, version: jwtKeyVersion(row.name) }))
    .filter((row): row is StoredSecret & { version: number } =>
      Boolean(row.version)
    )
    .sort((a, b) => a.version - b.version);
  return versions.map((row, i) => {
    // A key retires when any later version activates. That is not always the
    // next one: an immediate rotation overtakes a version still pending.
    const successors = versions.slice(i + 1).map((v) => v.createdAt.getTime());
    let publicKey: string;
    try {
      const key = createPrivateKey(row.value);
      if (key.asymmetricKeyType !== "rsa") throw new Error("not RSA");
      publicKey = createPublicKey(key)
        .export({ type: "spki", format: "pem" })
        .toString();
    } catch {
      throw new Error(`${row.name} is not a valid RSA private key`);
    }
    return {
      kid: jwkThumbprint(publicKey),
      version: row.version,
      privateKey: row.value,
      publicKey,
      activatesAt: row.createdAt,
      retiredAt:
        successors.length > 0 ? new Date(Math.min(...successors)) : null,
    };
  });
};

let refreshesStarted = 0;
let appliedRefresh = 0;

/**
 * Re-reads the stored signing keys: picks up a rotation by another process.
 * Refreshes overlap (the periodic one, an unknown kid's, a rotation's), so a
 * read only applies when no refresh that started after it has applied:
 * otherwise a slow read from before a rotation would put its keys back.
 */
export const refreshSigningKeys = async (): Promise<void> => {
  if (jwtKeysFromEnv) return;
  const refresh = ++refreshesStarted;
  lastRefresh = Date.now();
  const rows = await prisma.secret.findMany({
    where: { name: { startsWith: JWT_KEY_PREFIX } },
  });
  const keys = toSigningKeys(await openRows(rows));
  if (refresh < appliedRefresh) return;
  appliedRefresh = refresh;
  useSigningKeys(keys);
};

const REFRESH_ON_UNKNOWN_KID_MS = 10_000;

/**
 * The public key that verifies `token`, chosen by its `kid`; empty (which
 * jwt.verify refuses) when the kid is missing, unknown or retired too long
 * ago. An unknown kid may be a key another process just rotated in, so it
 * prompts a background refresh, at most every few seconds.
 */
export const verificationKeyFor = (token: string): string => {
  let kid: unknown;
  try {
    kid = jwt.decode(token, { complete: true })?.header.kid;
  } catch {
    return "";
  }
  if (typeof kid !== "string") return "";
  const now = Date.now();
  const key = signingKeys.find((k) => k.kid === kid);
  if (key) return isUsable(key, now) ? key.publicKey : "";
  if (now - lastRefresh > REFRESH_ON_UNKNOWN_KID_MS) {
    refreshSigningKeys().catch((err) =>
      logger.warn({ err }, "Refreshing JWT signing keys failed")
    );
  }
  return "";
};

/**
 * The keys the JWKS publishes, newest first: one not yet active, the active
 * one, and retired ones still within their retention.
 */
export const publishedSigningKeys = (): {
  kid: string;
  publicKey: string;
}[] => {
  const now = Date.now();
  return signingKeys
    .filter((k) => isUsable(k, now))
    .sort((a, b) => (b.version ?? 0) - (a.version ?? 0))
    .map(({ kid, publicKey }) => ({ kid, publicKey }));
};

export interface SigningKeySummary {
  kid: string;
  version: number | null;
  /** Whether it signs new tokens now. */
  active: boolean;
  /** When it starts (or started) signing. */
  activatesAt: Date | null;
  retiredAt: Date | null;
  /** When a retired key stops verifying and leaves the JWKS. */
  expiresAt: Date | null;
}

export const describeSigningKeys = (): SigningKeySummary[] => {
  const now = Date.now();
  const signing = currentSigningKey().kid;
  return signingKeys
    .filter((k) => isUsable(k, now))
    .sort((a, b) => (b.version ?? 0) - (a.version ?? 0))
    .map((k) => ({
      kid: k.kid,
      version: k.version,
      active: k.kid === signing,
      activatesAt: k.activatesAt,
      retiredAt: k.retiredAt,
      expiresAt: k.retiredAt
        ? new Date(k.retiredAt.getTime() + retentionMs())
        : null,
    }));
};

/**
 * How long a new signing key is published before it signs: two periodic
 * refreshes plus a margin, so every process, and every relying party that
 * refetches the JWKS on `core.signing-key.rotated`, knows the key before a
 * token carries its kid.
 */
export const ACTIVATION_DELAY_MS = 150_000;

export interface SigningKeyRotation {
  /** The new key. */
  kid: string;
  /** When it starts signing. */
  activatesAt: Date;
  /** The key it replaces, and when that one stops verifying. */
  retired: { kid: string; expiresAt: Date } | null;
}

/**
 * Generates the next signing key version, published at once and signing from
 * `ACTIVATION_DELAY_MS` later; until then the previous one keeps signing, and
 * afterwards it keeps verifying for one token lifetime (plus the logout-hint
 * grace). With `immediate` (for a compromised key) the new key signs at once
 * and every older version is deleted: tokens they signed, ID-token hints
 * included, stop verifying, and sessions get new ones on their next refresh.
 * `record` runs in the same transaction, for the audit entry. Keys past their
 * retention are deleted. Other processes re-read the keys on the broadcast
 * that follows, or failing that on their periodic refresh or when they see
 * the new kid.
 */
export const rotateSigningKey = async (
  {
    immediate = false,
  }: {
    immediate?: boolean;
  } = {},
  record?: (
    tx: Prisma.TransactionClient,
    rotation: SigningKeyRotation
  ) => Promise<void>
): Promise<{ keys: SigningKeySummary[]; activatesAt: Date }> => {
  if (jwtKeysFromEnv) {
    throw new ConflictError(
      "The JWT signing key is supplied in env (JWT_PRIVATE_KEY); rotate it there"
    );
  }
  await refreshSigningKeys();
  const latest = Math.max(...signingKeys.map((k) => k.version ?? 0));
  const name = `${JWT_KEY_PREFIX}${latest + 1}`;
  const privateKey = generateRsaPrivateKey();
  const kid = jwkThumbprint(
    createPublicKey(privateKey).export({ type: "spki", format: "pem" })
  );
  const value = await sealSecret(currentKek(), name, privateKey);
  // The row's created_at is its activation, when the previous key retires;
  // set here so the reported times are exact.
  const activatesAt = new Date(
    Date.now() + (immediate ? 0 : ACTIVATION_DELAY_MS)
  );
  // The key this one takes over from: on an immediate rotation the one
  // signing now, passing over any version still pending.
  const previous = signingKeyAt(activatesAt.getTime());
  const rotation: SigningKeyRotation = {
    kid,
    activatesAt,
    retired: {
      kid: previous.kid,
      expiresAt: immediate
        ? activatesAt
        : new Date(activatesAt.getTime() + retentionMs()),
    },
  };

  await prisma.$transaction(async (tx) => {
    const { count } = await tx.secret.createMany({
      data: [{ name, value, createdAt: activatesAt }],
      skipDuplicates: true,
    });
    if (count === 0) {
      throw new ConflictError(
        "Another rotation of the JWT signing key just ran; check the keys and retry if needed"
      );
    }
    if (immediate) {
      // A pending version goes too: it never signed, and nothing needs it.
      const older = (
        await tx.secret.findMany({
          where: { name: { startsWith: JWT_KEY_PREFIX } },
          select: { name: true },
        })
      )
        .map((row) => row.name)
        .filter((n) => (jwtKeyVersion(n) ?? Infinity) <= latest);
      await tx.secret.deleteMany({ where: { name: { in: older } } });
    }
    await record?.(tx, rotation);
  });

  await refreshSigningKeys();
  await broadcastSigningKeysChanged();
  const expired = signingKeys
    .filter((k) => !isUsable(k, Date.now()) && k.version !== null)
    .map((k) => `${JWT_KEY_PREFIX}${k.version}`);
  if (expired.length > 0) {
    await prisma.secret.deleteMany({ where: { name: { in: expired } } });
    await refreshSigningKeys();
  }
  logger.info(
    { kid, version: latest + 1, activatesAt },
    "Rotated the JWT signing key"
  );
  return { keys: describeSigningKeys(), activatesAt };
};

const SIGNING_KEY_REFRESH_MS = 60_000;

onSigningKeysChanged(() => {
  refreshSigningKeys().catch((err) =>
    logger.warn({ err }, "Refreshing JWT signing keys failed")
  );
});

/** Periodic refresh, so every process starts signing with a rotated key. */
export const startSigningKeyRefresh = (): (() => void) => {
  const timer = setInterval(() => {
    refreshSigningKeys().catch((err) =>
      logger.warn({ err }, "Refreshing JWT signing keys failed")
    );
  }, SIGNING_KEY_REFRESH_MS);
  timer.unref();
  return () => clearInterval(timer);
};

// ---------------------------------------------------------------------------
// Authorization codes
// ---------------------------------------------------------------------------

/** HMAC key for authorization-code binding and lookup hashes. */
export const authCodeHmacKey = (): Buffer => {
  const value = env.AUTH_CODE_HMAC_KEY;
  if (!value) throw new Error("loadKeys() has not run");
  return Buffer.from(value, "base64");
};

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

let loaded: Promise<void> | null = null;

export const loadKeys = (): Promise<void> => {
  loaded ??= load().catch((err) => {
    loaded = null;
    throw err;
  });
  return loaded;
};

const load = async () => {
  currentKek();
  const specs = keySpecs();

  const jwtEnv = ["JWT_PRIVATE_KEY", "JWT_PUBLIC_KEY"].filter(isPresent);
  if (jwtEnv.length === 1) {
    throw new Error(
      `JWT_PRIVATE_KEY and JWT_PUBLIC_KEY must be supplied together; only ${jwtEnv[0]} is set`
    );
  }
  jwtKeysFromEnv = jwtEnv.length === 2;

  // Stored keys fill whatever env left unset, other versions included.
  const stored = await openRows(await prisma.secret.findMany());
  for (const { name, value } of stored) {
    if (jwtKeyVersion(name) === null && !isPresent(name)) apply(name, value);
  }

  const toGenerate: { name: string; value: string }[] = [];
  for (const spec of specs) {
    if (!isPresent(spec.name)) {
      toGenerate.push({ name: spec.name, value: spec.generate() });
    }
  }
  if (
    !jwtKeysFromEnv &&
    !stored.some(({ name }) => jwtKeyVersion(name) !== null)
  ) {
    toGenerate.push({
      name: `${JWT_KEY_PREFIX}1`,
      value: generateRsaPrivateKey(),
    });
  }

  if (toGenerate.length > 0) {
    const k = currentKek();
    const sealed = await Promise.all(
      toGenerate.map(async ({ name, value }) => ({
        name,
        value: await sealSecret(k, name, value),
      }))
    );
    // One statement, so processes starting together keep the first writer's
    // keys.
    await prisma.secret.createMany({ data: sealed, skipDuplicates: true });
    const rows = await prisma.secret.findMany({
      where: { name: { in: sealed.map((s) => s.name) } },
    });
    const created = rows.filter((row) =>
      sealed.some((s) => s.name === row.name && s.value === row.value)
    );
    for (const { name, value } of await openRows(rows)) {
      if (jwtKeyVersion(name) === null) apply(name, value);
    }
    if (created.length > 0) {
      logger.info(
        { keys: created.map((k) => k.name) },
        "Generated keys and stored them in core.secrets"
      );
    }
  }

  for (const spec of specs) {
    // Master keys are validated by the registry as they are set.
    if (masterKeyVersion(spec.name) !== null) continue;
    if (!spec.valid(valueOf(spec.name) ?? "")) {
      throw new Error(`${spec.name} is not a valid key`);
    }
  }

  if (jwtKeysFromEnv) {
    let publicKey: string;
    let modulusLength: number | undefined;
    try {
      const derived = createPublicKey(createPrivateKey(env.JWT_PRIVATE_KEY));
      if (derived.asymmetricKeyType !== "rsa") throw new Error("not RSA");
      modulusLength = derived.asymmetricKeyDetails?.modulusLength;
      publicKey = createPublicKey(env.JWT_PUBLIC_KEY)
        .export({ type: "spki", format: "pem" })
        .toString();
      if (
        derived.export({ type: "spki", format: "pem" }).toString() !== publicKey
      ) {
        throw new Error("mismatch");
      }
    } catch {
      throw new Error(
        "JWT_PRIVATE_KEY / JWT_PUBLIC_KEY is not a valid, matching RSA key pair"
      );
    }
    if (!modulusLength || modulusLength < MIN_RSA_MODULUS_BITS) {
      throw new Error(
        `JWT_PRIVATE_KEY must be an RSA key of at least ${MIN_RSA_MODULUS_BITS} bits; it has ${modulusLength ?? "an unknown number of"}`
      );
    }
    useSigningKeys([
      {
        kid: env.JWT_KEY_ID ?? jwkThumbprint(publicKey),
        version: null,
        privateKey: env.JWT_PRIVATE_KEY,
        publicKey: env.JWT_PUBLIC_KEY,
        activatesAt: null,
        retiredAt: null,
      },
    ]);
  } else {
    await refreshSigningKeys();
  }
};
