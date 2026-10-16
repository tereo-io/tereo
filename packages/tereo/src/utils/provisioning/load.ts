import { CLIENT_SECRET_PREFIX, secretStrengthProblem } from "../secretRules.js";
import { isRequestableCoreRole } from "../../definitions/roles.js";
import { CORE_SERVICE } from "../../definitions/coreService.js";
import { isSafeRedirectUri } from "../redirectUris.js";
import { readFile, readdir, stat } from "fs/promises";
import { hashFlowToken } from "../crypto.js";
import { basename, join } from "path";
import { parse } from "yaml";
import type { z } from "zod";
import {
  ProvisioningDocumentSchema,
  ProvisioningFileSchema,
  type CustomRoleEntry,
} from "./schema.js";

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
const describeIssue = (issue: z.core.$ZodIssue, root = "file"): string => {
  const path =
    issue.path
      .map((part, i) =>
        typeof part === "number"
          ? `[${part}]`
          : i
            ? `.${String(part)}`
            : String(part)
      )
      .join("") || root;
  const where = path ? `${path}: ` : "";
  if (issue.code === "unrecognized_keys")
    return `${where}unknown key ${issue.keys.map((k) => `"${k}"`).join(", ")}`;
  return `${where}${issue.message}`;
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

interface ClientRules {
  label: string;
  clientType: "public" | "confidential";
  secretFrom?: string;
  grantTypes: string[];
  redirectUris: string[];
  postLogoutRedirectUris: string[];
}

// The rules one login client must meet on its own.
const checkClient = (c: ClientRules, problems: string[]) => {
  if (c.clientType === "confidential" && !c.secretFrom)
    problems.push(`${c.label}: a confidential client needs secretFrom`);
  else if (c.clientType === "public" && c.secretFrom)
    problems.push(
      `${c.label}: a public client has no secret; remove secretFrom`
    );

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
    throw new ProvisioningError(
      parsed.error.issues.map((i) => describeIssue(i))
    );

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
    checkClient(c, problems);
    if (c.clientType === "confidential" && c.secretFrom)
      uses.push({ label: c.label, envName: c.secretFrom });

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
  // Not env.ts: the file names the variables its secrets come from.
  env: NodeJS.ProcessEnv = process.env
): Promise<Provisioning | null> => {
  if (!path) return null;
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "error";
    throw new ProvisioningError([
      `cannot read PROVISIONING_PATH ${path}: ${code}`,
    ]);
  }
  return parseProvisioning(text, env);
};

export interface ResolvedWebhook {
  key: string;
  url: string;
  events: string[];
  organizations: "all" | string[];
  description: string | null;
  secretEnv: string;
  // Webhook secrets are sealed, not hashed, so the plaintext stays in memory.
  secretPlain: string;
}

type ServiceOutput = NonNullable<
  z.output<typeof ProvisioningDocumentSchema>["service"]
>;

export interface ResolvedService extends Omit<
  ProvisionedServiceSpec,
  "access"
> {
  access: ServiceOutput["access"];
  permissions: ServiceOutput["permissions"];
  systemRoles: ServiceOutput["systemRoles"];
  buckets: ServiceOutput["buckets"];
  eventTypes: ServiceOutput["eventTypes"];
  webhooks: ResolvedWebhook[];
}

export interface ResolvedClient extends ProvisionedClientSpec {
  description: string | null;
}

export interface LoadedDocument {
  file: string;
  version: string;
  service: ResolvedService | null;
  clients: ResolvedClient[];
  roles: CustomRoleEntry[];
}

export interface ProvisioningSet {
  documents: LoadedDocument[];
}

export const readProvisioningPath = async (
  path: string
): Promise<{ file: string; text: string }[]> => {
  const unreadable = (err: unknown): never => {
    const code = (err as NodeJS.ErrnoException).code ?? "error";
    throw new ProvisioningError([
      `cannot read PROVISIONING_PATH ${path}: ${code}`,
    ]);
  };

  let info;
  try {
    info = await stat(path);
  } catch (err) {
    return unreadable(err);
  }

  if (!info.isDirectory()) {
    try {
      return [{ file: basename(path), text: await readFile(path, "utf8") }];
    } catch (err) {
      return unreadable(err);
    }
  }

  let names: string[];
  try {
    names = await readdir(path);
  } catch (err) {
    return unreadable(err);
  }

  const files: { file: string; text: string }[] = [];
  for (const name of names.sort()) {
    if (name.startsWith(".") || !name.endsWith(".json")) continue;
    // stat follows links: a mounted ConfigMap's entries are symlinks.
    try {
      if (!(await stat(join(path, name))).isFile()) continue;
      files.push({
        file: name,
        text: await readFile(join(path, name), "utf8"),
      });
    } catch (err) {
      return unreadable(err);
    }
  }
  if (files.length === 0)
    throw new ProvisioningError([`no provisioning documents in ${path}`]);
  return files;
};

interface DocumentSecretUse extends SecretUse {
  // Entries with the same owner may share a value; webhooks of one service.
  owner: string | null;
}

// Returns env var name -> plain value. Callers hash what is stored hashed.
const resolveDocumentSecrets = (
  uses: DocumentSecretUse[],
  env: NodeJS.ProcessEnv,
  problems: string[]
): Map<string, string> => {
  const values = new Map<string, string>();
  const usesByValue = new Map<string, DocumentSecretUse[]>();

  for (const use of uses) {
    const { label, envName } = use;
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
    values.set(envName, value);
    usesByValue.set(value, [...(usesByValue.get(value) ?? []), use]);
  }

  for (const group of usesByValue.values()) {
    const owner = group[0].owner;
    const shared = owner !== null && group.every((u) => u.owner === owner);
    if (group.length > 1 && !shared)
      problems.push(
        `${group.map((u) => u.label).join(" and ")}: a secret is used by more than one entry; each needs its own`
      );
  }

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
  return values;
};

const jsonSyntaxProblem = (err: unknown): string => {
  // The message can quote the source text, which may hold a secret; only the
  // position is kept.
  const message = err instanceof Error ? err.message : "";
  const at = /position (\d+)/.exec(message);
  return at ? `not valid JSON (at position ${at[1]})` : "not valid JSON";
};

export const parseDocuments = (
  files: { file: string; text: string }[],
  env: NodeJS.ProcessEnv
): ProvisioningSet => {
  const problems: string[] = [];
  const parsedDocs: {
    file: string;
    data: z.output<typeof ProvisioningDocumentSchema>;
  }[] = [];

  for (const { file, text } of files) {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      problems.push(`${file}: ${jsonSyntaxProblem(err)}`);
      continue;
    }
    const parsed = ProvisioningDocumentSchema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues)
        problems.push(`${file}: ${describeIssue(issue, "document")}`);
      continue;
    }
    parsedDocs.push({ file, data: parsed.data });
  }

  const uses: DocumentSecretUse[] = [];
  for (const { file, data } of parsedDocs) {
    const { service } = data;
    if (service) {
      const label = `${file}: service[${service.slug}]`;
      uses.push({ label, envName: service.secretFrom, owner: null });
      for (const w of service.webhooks)
        uses.push({
          label: `${label} webhook[${w.key}]`,
          envName: w.secretFrom,
          owner: `${file}:${service.slug}`,
        });
    }
    for (const c of data.clients ?? []) {
      const label = `${file}: clients[${c.clientId}]`;
      checkClient({ ...c, label }, problems);
      if (c.clientType === "confidential" && c.secretFrom)
        uses.push({ label, envName: c.secretFrom, owner: null });
    }
  }

  const values = resolveDocumentSecrets(uses, env, problems);
  if (problems.length > 0) throw new ProvisioningError(problems);

  const hashOf = (envName: string) => hashFlowToken(values.get(envName)!);

  return {
    documents: parsedDocs.map(({ file, data }) => ({
      file,
      version: data.version,
      service: data.service
        ? {
            slug: data.service.slug,
            name: data.service.name,
            namespace:
              data.service.namespace ?? withoutServiceSuffix(data.service.slug),
            clientId: data.service.clientId ?? data.service.slug,
            secretEnv: data.service.secretFrom,
            secretHash: hashOf(data.service.secretFrom),
            access: data.service.access,
            permissions: data.service.permissions,
            systemRoles: data.service.systemRoles,
            buckets: data.service.buckets,
            eventTypes: data.service.eventTypes,
            webhooks: data.service.webhooks.map((w) => ({
              key: w.key,
              url: w.url,
              events: w.events,
              organizations: w.organizations,
              description: w.description ?? null,
              secretEnv: w.secretFrom,
              secretPlain: values.get(w.secretFrom)!,
            })),
          }
        : null,
      clients: (data.clients ?? []).map((c) => ({
        clientId: c.clientId,
        name: c.name,
        description: c.description ?? null,
        clientType: c.clientType,
        secretEnv: c.secretFrom ?? null,
        secretHash:
          c.clientType === "confidential" && c.secretFrom
            ? hashOf(c.secretFrom)
            : null,
        redirectUris: c.redirectUris,
        postLogoutRedirectUris: c.postLogoutRedirectUris,
        scopes: c.scopes,
        grantTypes: c.grantTypes,
        audience: c.audience,
        consentRequired: c.consentRequired,
      })),
      roles: data.roles ?? [],
    })),
  };
};

export const loadProvisioningSet = async (
  path: string | undefined,
  // Not env.ts: the documents name the variables their secrets come from.
  env: NodeJS.ProcessEnv = process.env
): Promise<ProvisioningSet | null> => {
  if (!path) return null;
  return parseDocuments(await readProvisioningPath(path), env);
};
