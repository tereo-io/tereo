// @tereo-io/sdk: what app services use to reach core. Start with
// `createCoreClient`. The request handler and its transport-level types are
// published separately, as `@tereo-io/sdk/handler` (src/handler.ts),
// because several of them share names with the SDK-level types below.

export { createCoreClient } from "./coreClient.js";
export type { CoreClient, CoreClientOptions } from "./coreClient.js";

// The compact objects responses embed beside the ids they return.
export type { OrgRef, RoleRef, ServiceRef, UserRef } from "./handler.js";

// --- Outbox ----------------------------------------------------------------

export { OutboxClient } from "./clients/outbox.js";
export { outboxTableSql } from "./utils/outboxSchema.js";
export type { OutboxOptions, OutboxRow, SqlClient } from "./types/outbox.js";

// --- Provisioning ----------------------------------------------------------

export type {
  BucketProvisioning,
  CustomRole,
  EventTypeProvisioning,
  LoginClientProvisioning,
  PermissionProvisioning,
  ProvisioningDocument,
  ServiceProvisioning,
  SystemRoleProvisioning,
  WebhookSubscription,
} from "./types/provisioning.js";

// --- Auth --------------------------------------------------------------------

export { parseTestToken } from "./utils/testTokens.js";
export { requestIdMiddleware } from "./utils/requestId.js";
export {
  HttpError,
  UnauthorizedError,
  ForbiddenError,
} from "./utils/errors.js";
export { AuthServiceClient } from "./clients/auth.js";
export type {
  AuthServiceClientConfig,
  IntrospectionResponse,
  ActiveIntrospectionResponse,
  InactiveIntrospectionResponse,
  AuthServiceOrganization,
  AuthServiceUser,
  AuthContext,
  OrganizationContext,
  UserType,
  PublicRouteConfig,
} from "./types/auth.js";

// --- Files -------------------------------------------------------------------

export { FileServiceClient } from "./clients/files.js";
export {
  startFileServiceCache,
  closeFileServiceCache,
} from "./utils/fileCache.js";

// SDK-local types (bucket management + permissions) plus the object-level
// types re-exported from the request handler for convenience.
export type {
  FileServiceClientConfig,
  FileServiceBucketName,
  FileServiceObject,
  FileServiceObjectMetadata,
  UploadObjectInput,
  ListObjectsOptions,
  ListObjectsResponse,
  Bucket,
  CorsConfig,
  RateLimitConfig,
  ListBucketsOptions,
  ListBucketsResponse,
  CreateBucketInput,
  UpdateBucketInput,
  BucketPermission,
  ListBucketPermissionsOptions,
  ListBucketPermissionsResponse,
  GrantBucketPermissionInput,
  MyBucketPermissions,
} from "./types/files.js";

export type {
  ListPrefixesOptions,
  ListPrefixesResponse,
  PrefixEntry,
  PrefixObjectEntry,
  PrefixListEntry,
  ObjectVersion,
  ListObjectVersionsOptions,
  ListObjectVersionsResponse,
  RestoreObjectVersionResponse,
  PresignObjectInput,
  PresignObjectResponse,
  PresignOperation,
  LifecyclePolicy,
  UpsertLifecyclePolicyInput,
  InitiateMultipartInput,
  InitiateMultipartResponse,
  UploadPartInput,
  UploadPartResponse,
  MultipartUploadInfo,
  MultipartPartInfo,
  CompleteMultipartInput,
  CompleteMultipartResponse,
} from "./handler.js";

// --- Webhooks ----------------------------------------------------------------

export { WebhookServiceClient } from "./clients/webhooks.js";
export { createWebhookVerifier } from "./utils/webhookVerify.js";
export type {
  WebhookServiceClientConfig,
  EmitEventParams,
  EmitEventResult,
  EmitBatchResult,
} from "./types/webhooks.js";

// --- Notifications -----------------------------------------------------------

export { NotificationsClient } from "./clients/notifications.js";
export type {
  Notification,
  NotificationAttachment,
  NotificationChannel,
  NotificationDelivery,
  NotificationInput,
  EmailAddress,
  EmailContent,
  EmailNotificationInput,
  EmailRecipient,
  SendNotificationInput,
  SendNotificationResult,
} from "./types/notifications.js";

// --- Audit -------------------------------------------------------------------

export { AuditLogServiceClient } from "./clients/audit.js";
export type {
  AuditLogServiceClientConfig,
  AuditLogEntryInput,
  AuditLogResult,
  AuditLogReadResult,
  AuditLogActor,
  AuditLogBatchResult,
  AuditLogQueryResult,
  AuditLogQueryOptions,
  AuditLogEntityQueryOptions,
  QueryByEntityOrMetadataOptions,
  AuditLogAction,
  AuditLogWritableAction,
  AuditLogChanges,
  AuditLogMetadata,
} from "./types/audit.js";

// --- Errors ------------------------------------------------------------------

export {
  RequestError,
  getOriginalStatus,
  getOriginalResponseData,
} from "./handler.js";
export type { RequestErrorMetadata } from "./handler.js";
export { InvalidAuditEntryError } from "./utils/auditSchemas.js";
export { InvalidRequestInputError } from "./utils/errors.js";
export { UnknownEventTypeError } from "./clients/webhooks.js";
