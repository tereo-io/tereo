import { CLIENT_SECRET_PREFIX, secretStrengthProblem } from "../secretRules.js";
import { isRequestableCoreRole } from "../../definitions/roles.js";
import { CORE_SERVICE } from "../../definitions/coreService.js";
import { isSafeRedirectUri } from "../redirectUris.js";
import { ProvisioningFileSchema } from "./schema.js";
import { hashFlowToken } from "../crypto.js";
import { readFile } from "fs/promises";
import { parse } from "yaml";
import type { z } from "zod";

export interface ProvisionedServiceSpec {
  slug: string;
  name: string;
  namespace: string;
  clientId: string;
  secretEnv: string;
  secretHash: string;
  access: { roles: string[]; audiences: string[] };
}

export interface ProvisionedClientSpec {
  clientId: string;
  name: string;
  clientType: "public" | "confidential";
  secretEnv: string | null;
  secretHash: string | null;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  scopes: string[];
  grantTypes: ("authorization_code" | "refresh_token")[];
  audience: string[];
  consentRequired: boolean;
}

export interface Provisioning {
  services: ProvisionedServiceSpec[];
  clients: ProvisionedClientSpec[];
}

export class ProvisioningError extends Error {
  constructor(public problems: string[]) {
    super(
      `Invalid provisioning file:\n${problems.map((p) => `  - ${p}`).join("\n")}`
    );
    this.name = "ProvisioningError";
  }
}

// Zod's own messages describe the rule, not the received value, so a
// misplaced secret never reaches the output. Unknown keys are named: they are
// the file's keys, not its values.
const describeIssue = (issue: z.core.$ZodIssue): string => {
  const path =
    issue.path
      .map((part, i) =>
        typeof part === "number"
          ? `[${part}]`
          : i
            ? `.${String(part)}`
            : String(part)
      )
      .join("") || "file";
  if (issue.code === "unrecognized_keys")
    return `${path}: unknown key ${issue.keys.map((k) => `"${k}"`).join(", ")}`;
  return `${path}: ${issue.message}`;
};

const withoutServiceSuffix = (slug: string) =>
  slug.replace(/-service$/, "") || slug;

// A secret pasted where its variable's name belongs would otherwise be
// echoed in the problems below.
const looksLikeSecret = (envName: string) =>
  envName.startsWith(CLIENT_SECRET_PREFIX) || envName.length > 64;

interface SecretUse {
  label: string;
  envName: string;
}

// Returns env var name -> hash. The plain values never leave this function.
const resolveSecrets = (
  uses: SecretUse[],
  env: NodeJS.ProcessEnv,
  problems: string[]
): Map<string, string> => {
  const hashes = new Map<string, string>();
  const labelsByValue = new Map<string, string[]>();

  for (const { label, envName } of uses) {
    if (looksLikeSecret(envName)) {
      problems.push(
        `${label}: secretFrom does not look like an environment variable name`
      );
      continue;
    }
    const value = env[envName];
    if (!value) {
      problems.push(`${label}: ${envName} is not set`);
      continue;
    }
    const weak = secretStrengthProblem(value);
    if (weak) {
      problems.push(`${label}: ${envName} ${weak}`);
      continue;
    }
    hashes.set(envName, hashFlowToken(value));
    labelsByValue.set(value, [...(labelsByValue.get(value) ?? []), label]);
  }

  for (const labels of labelsByValue.values()) {
    if (labels.length > 1)
      problems.push(
        `${labels.join(" and ")} use the same secret; each needs its own`
      );
  }

  // Variables read as secrets are compared among themselves above.
  const secretVars = new Set(uses.map((u) => u.envName));
  for (const { label, envName } of uses) {
    const value = env[envName];
    if (!value || looksLikeSecret(envName)) continue;
    for (const [other, otherValue] of Object.entries(env)) {
      if (other !== envName && !secretVars.has(other) && otherValue === value)
        problems.push(
          `${label}: ${envName} has the same value as ${other}; use a separate secret`
        );
    }
  }
  return hashes;
};

const checkDuplicates = (
  kind: string,
  values: string[],
  problems: string[]
) => {
  const seen = new Set<string>();
  const reported = new Set<string>();
  for (const value of values) {
    if (seen.has(value) && !reported.has(value)) {
      problems.push(`${kind} "${value}" is used by more than one entry`);
      reported.add(value);
    }
    seen.add(value);
  }
};

export const parseProvisioning = (
  text: string,
  env: NodeJS.ProcessEnv
): Provisioning => {
  let raw: unknown;
  try {
    raw = parse(text) ?? {};
  } catch (err) {
    const first =
      err instanceof Error ? err.message.split("\n")[0] : "parse error";
    throw new ProvisioningError([`file is not valid YAML: ${first}`]);
  }

  const parsed = ProvisioningFileSchema.safeParse(raw);
  if (!parsed.success)
    throw new ProvisioningError(parsed.error.issues.map(describeIssue));

  const problems: string[] = [];

  const services = parsed.data.services.map((s) => ({
    ...s,
    label: `services[${s.slug}]`,
    namespace: s.namespace ?? withoutServiceSuffix(s.slug),
    clientId: s.clientId ?? s.slug,
  }));
  const clients = parsed.data.clients.map((c) => ({
    ...c,
    label: `clients[${c.clientId}]`,
  }));

  checkDuplicates(
    "service slug",
    services.map((s) => s.slug),
    problems
  );
  checkDuplicates(
    "namespace",
    services.map((s) => s.namespace),
    problems
  );
  checkDuplicates(
    "clientId",
    [...services.map((s) => s.clientId), ...clients.map((c) => c.clientId)],
    problems
  );

  for (const s of services) {
    for (const role of s.access.roles)
      if (!isRequestableCoreRole(role))
        problems.push(
          `${s.label}: access.roles "${role}" is not a core role services may request`
        );
    for (const audience of s.access.audiences)
      if (audience === CORE_SERVICE.slug || audience === s.slug)
        problems.push(
          `${s.label}: access.audiences must not name "${audience}"`
        );
  }

  const uses: SecretUse[] = services.map((s) => ({
    label: s.label,
    envName: s.secretFrom,
  }));
  for (const c of clients) {
    if (c.clientType === "confidential" && !c.secretFrom)
      problems.push(`${c.label}: a confidential client needs secretFrom`);
    else if (c.clientType === "public" && c.secretFrom)
      problems.push(
        `${c.label}: a public client has no secret; remove secretFrom`
      );
    else if (c.secretFrom) uses.push({ label: c.label, envName: c.secretFrom });

    if (
      c.grantTypes.includes("authorization_code") &&
      c.redirectUris.length === 0
    )
      problems.push(
        `${c.label}: a client with the authorization_code grant needs at least one redirect URI`
      );

    c.redirectUris.forEach((uri, i) => {
      if (!isSafeRedirectUri(uri))
        problems.push(`${c.label}: redirectUris[${i}] is not a safe URL`);
    });
    c.postLogoutRedirectUris.forEach((uri, i) => {
      if (!isSafeRedirectUri(uri))
        problems.push(
          `${c.label}: postLogoutRedirectUris[${i}] is not a safe URL`
        );
    });
    for (const audience of c.audience)
      if (audience === CORE_SERVICE.slug)
        problems.push(`${c.label}: audience must not name "${audience}"`);
  }

  const hashes = resolveSecrets(uses, env, problems);

  if (problems.length > 0) throw new ProvisioningError(problems);

  return {
    services: services.map((s) => ({
      slug: s.slug,
      name: s.name,
      namespace: s.namespace,
      clientId: s.clientId,
      secretEnv: s.secretFrom,
      secretHash: hashes.get(s.secretFrom)!,
      access: { roles: s.access.roles, audiences: s.access.audiences },
    })),
    clients: clients.map((c) => ({
      clientId: c.clientId,
      name: c.name,
      clientType: c.clientType,
      secretEnv: c.secretFrom ?? null,
      secretHash: c.secretFrom ? hashes.get(c.secretFrom)! : null,
      redirectUris: c.redirectUris,
      postLogoutRedirectUris: c.postLogoutRedirectUris,
      scopes: c.scopes,
      grantTypes: c.grantTypes,
      audience: c.audience,
      consentRequired: c.consentRequired,
    })),
  };
};

export const loadProvisioning = async (
  path: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): Promise<Provisioning | null> => {
  if (!path) return null;
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "error";
    throw new ProvisioningError([
      `cannot read PROVISIONING_FILE ${path}: ${code}`,
    ]);
  }
  return parseProvisioning(text, env);
};
