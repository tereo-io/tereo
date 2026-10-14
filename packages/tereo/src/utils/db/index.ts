import * as notificationConnections from "./notificationConnections.js";
import { Prisma } from "../../../prisma/generated/client/index.js";
import * as orgSelectionSessions from "./orgSelectionSessions.js";
import * as idempotencyRecords from "./idempotencyRecords.js";
import * as authorizationCode from "./authorizationCode.js";
import * as bucketPermissions from "./bucketPermissions.js";
import * as lifecyclePolicies from "./lifecyclePolicies.js";
import * as webhookDeliveries from "./webhookDeliveries.js";
import * as identityProviders from "./identityProviders.js";
import * as multipartUploads from "./multipartUploads.js";
import * as webhookEndpoints from "./webhookEndpoints.js";
import * as auditLogEntries from "./auditLogEntries.js";
import * as objectVersions from "./objectVersions.js";
import * as userIdentities from "./userIdentities.js";
import * as notifications from "./notifications.js";
import * as organizations from "./organizations.js";
import * as refreshTokens from "./refreshTokens.js";
import * as outboxFanouts from "./outboxFanouts.js";
import * as upstreamAuth from "./upstreamAuth.js";
import * as accessTokens from "./accessTokens.js";
import * as userSessions from "./userSessions.js";
import * as contentBlobs from "./contentBlobs.js";
import * as permissions from "./permissions.js";
import * as eventTypes from "./eventTypes.js";
import * as accessLogs from "./accessLogs.js";
import * as loginFlows from "./loginFlows.js";
import * as settings from "./settings.js";
import * as archives from "./archives.js";
import * as services from "./services.js";
import * as clients from "./clients.js";
import * as consent from "./consent.js";
import * as buckets from "./buckets.js";
import * as objects from "./objects.js";
import * as outbox from "./outbox.js";
import * as scopes from "./scopes.js";
import * as shares from "./shares.js";
import { prisma } from "./prisma.js";
import * as roles from "./roles.js";
import * as users from "./users.js";
import * as totp from "./totp.js";

const $transaction = <T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> => prisma.$transaction(fn);

// One namespace per table group. `permissions` are auth's role permissions;
// `bucketPermissions` are per-bucket grants.
export default {
  $transaction,
  // auth
  accessTokens,
  authorizationCode,
  clients,
  consent,
  identityProviders,
  loginFlows,
  organizations,
  orgSelectionSessions,
  permissions,
  refreshTokens,
  roles,
  scopes,
  settings,
  totp,
  upstreamAuth,
  userIdentities,
  userSessions,
  users,
  // files
  accessLogs,
  archives,
  bucketPermissions,
  buckets,
  contentBlobs,
  idempotencyRecords,
  lifecyclePolicies,
  multipartUploads,
  objects,
  objectVersions,
  shares,
  // webhooks
  eventTypes,
  outboxFanouts,
  webhookDeliveries,
  webhookEndpoints,
  // audit
  auditLogEntries,
  // notifications
  notificationConnections,
  notifications,
  // core
  outbox,
  services,
};
