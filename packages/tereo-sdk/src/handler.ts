import RequestHandler, { buildClientName } from "@dianemo/core";
import { redisBackend } from "@dianemo/backend-redis";
import _requests from "./requests/index.js";
import { logger } from "./utils/logger.js";
import type { Redis } from "ioredis";
import {
  CORE_TEMPLATE,
  ONCE_SUB_CLIENT,
  registerCoreTemplate,
} from "./templates/core.js";

/**
 * The request handler every SDK call goes through: one per process, made by
 * `createCoreClient`, holding one client for core (and its `:public` twin).
 */

const INSTANCE_ID = "sdk";

/** The client every authenticated call uses. */
export const CORE_CLIENT = buildClientName(CORE_TEMPLATE, {
  instanceId: INSTANCE_ID,
  organizationId: null,
});

/** The same credentials as Basic auth, for client-authenticated endpoints. */
export const CORE_PUBLIC_CLIENT = `${CORE_CLIENT}:public`;

/**
 * `CORE_CLIENT`'s token without the retries after a 5xx or a dropped
 * connection: for creates that a repeat would duplicate.
 */
export const CORE_ONCE_CLIENT = `${CORE_CLIENT}:${ONCE_SUB_CLIENT}`;

export interface HandlerOptions {
  /** Core's base URL, e.g. `http://localhost:4001`. */
  url: string;
  clientId: string;
  clientSecret: string;
  /** Encrypts the credentials the handler stores; 32+ characters. */
  requestHandlerKey: string;
  /** Shared state (rate limits, tokens). Owned by the caller. */
  redis: Redis;
  /** Production handlers take priority over others sharing the Redis. */
  production?: boolean;
}

let handler: RequestHandler | null = null;

export const createHandler = (options: HandlerOptions): RequestHandler => {
  if (handler) {
    throw new Error(
      "@tereo-io/sdk: createCoreClient() was already called in this process"
    );
  }
  const created = new RequestHandler({
    key: options.requestHandlerKey,
    backend: redisBackend(options.redis),
    logger,
    priority: options.production ? 2 : 1,
    // The handler keeps tokens and rate-limit state in Redis under its client
    // names, which are the same for every service. Namespacing by client id
    // lets replicas of one service share that state while two services on
    // one Redis can never use each other's tokens.
    keyPrefix: `@tereo-io/sdk:${options.clientId}`,
  });
  created.registerStartupHook(registerCoreTemplate);
  created.registerStartupHook((h) =>
    h.addLocalTemplateClient(CORE_TEMPLATE, {
      instanceId: INSTANCE_ID,
      organizationId: null,
      baseUrl: options.url.replace(/\/+$/, ""),
      clientId: options.clientId,
      clientSecret: options.clientSecret,
    })
  );
  handler = created;
  return created;
};

export const getHandler = (): RequestHandler => {
  if (!handler) {
    throw new Error(
      "@tereo-io/sdk: call createCoreClient() before making requests"
    );
  }
  return handler;
};

/**
 * Drops the cached service token, so the next request mints a new one: for a
 * token core stopped accepting (revoked, or its signing key rotated) before
 * it expired.
 */
export const purgeServiceToken = async (): Promise<void> => {
  // `getClient` is protected in @dianemo/core's types; the client it returns
  // has `purgeCredentials` as a public method.
  const h = getHandler() as unknown as {
    getClient(name: string): { purgeCredentials(): Promise<void> };
  };
  await h.getClient(CORE_CLIENT).purgeCredentials();
};

/** Forget the handler (after `stop()`), so a test can create another. */
export const resetHandler = () => {
  handler = null;
};

export const requests = _requests;

// Avoids a direct @dianemo/core dep for callers that only need clientName parsing.
export { buildClientName, parseClientName } from "@dianemo/core";
export type { ParsedClientName, RateLimitOverrides } from "@dianemo/core";

export {
  RequestError,
  getOriginalStatus,
  getOriginalResponseData,
} from "./utils/errors.js";
export type { RequestErrorMetadata } from "./utils/errors.js";

export type { OrgRef, RoleRef, ServiceRef, UserRef } from "./requests/refs.js";

export type {
  Bucket,
  BucketPolicy,
  CorsConfig as FileServiceCorsConfig,
  RateLimitConfig as FileServiceRateLimitConfig,
  ListBucketsOptions,
  ListBucketsResponse,
  CreateBucketInput,
  UpdateBucketInput,
  MyBucketPermissions,
} from "./requests/files/buckets/types.js";

export type {
  BucketPermission,
  ListBucketPermissionsOptions,
  ListBucketPermissionsResponse,
  GrantBucketPermissionInput,
} from "./requests/files/permissions/types.js";

export type {
  BulkDeleteInput,
  BulkDeleteResponse,
  FileServiceObject,
  FileServiceObjectMetadata,
  ListObjectsOptions,
  ListObjectsResponse,
  PatchObjectInput,
  PurgeNonCurrentVersionsResponse,
  UploadObjectInput,
} from "./requests/files/objects/types.js";

export type {
  ListPrefixesOptions,
  ListPrefixesResponse,
  PrefixEntry,
  PrefixObjectEntry,
  PrefixListEntry,
} from "./requests/files/prefixes/types.js";

export type {
  ListObjectVersionsOptions,
  ListObjectVersionsResponse,
  ObjectVersion,
  RestoreObjectVersionResponse,
} from "./requests/files/versions/types.js";

export type {
  PresignObjectInput,
  PresignObjectResponse,
  PresignOperation,
} from "./requests/files/presign/types.js";

export type {
  LifecyclePolicy,
  UpsertLifecyclePolicyInput,
} from "./requests/files/lifecycle/types.js";

export type {
  CompleteMultipartInput,
  CompleteMultipartResponse,
  InitiateMultipartInput,
  InitiateMultipartResponse,
  MultipartPartInfo,
  MultipartUploadInfo,
  UploadPartInput,
  UploadPartResponse,
} from "./requests/files/multipart/types.js";

export type {
  ArchiveFormat,
  CreateArchiveInput,
  CreateArchiveResponse,
} from "./requests/files/archives/types.js";

export type {
  AuditLogEntryWithNames,
  AuditLogAction,
  AuditLogWritableAction,
  AuditLogActor,
  AuditLogChanges,
  AuditLogEntry,
  AuditLogMetadata,
  CreateBatchInput,
  CreateBatchResult,
  CreateEntryInput,
  GetByEntityParams as AuditLogGetByEntityParams,
  ListEntriesParams as AuditLogListEntriesParams,
  PaginatedAuditLogEntries,
} from "./requests/audit/types.js";

export type {
  CreateArchiveShareInput,
  CreateObjectShareInput,
  CreateShareInput,
  ListSharesOptions,
  ListSharesResponse,
  Share,
  ShareArchiveFormat,
  ShareKind,
  ShareStatus,
  ShareTargetArchive,
  ShareTargetObject,
  UpdateShareInput,
} from "./requests/files/shares/types.js";

export type {
  ActiveIntrospectionResponse,
  IntrospectionResponse,
  InactiveIntrospectionResponse,
  ServiceAccessTokenResponse,
} from "./requests/auth/oauth/types.js";

export type {
  AuthServiceUser,
  AuthServiceUserRole,
  AuthServiceUserPermissionsResponse,
} from "./requests/auth/users/types.js";

export type { AuthServiceOrganization } from "./requests/auth/organizations/types.js";

export type {
  AuthServiceClientType,
  AuthServiceOrgMemberRole,
  AuthServiceTotpPolicy,
  AuthServiceUserType,
} from "./requests/auth/types.js";

export type {
  EmitEventParams,
  EmitEventResult,
  EmitBatchInput,
  EmitBatchResult,
} from "./requests/webhooks/types.js";
