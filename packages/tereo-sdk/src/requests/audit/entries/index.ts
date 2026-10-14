import { tryHandleRequest } from "../../../utils/tryHandleRequest.js";
import { CORE_CLIENT } from "../../../handler.js";
import { urlPath } from "../../paths.js";
import type {
  AuditLogEntryWithNames,
  AuditLogEntry,
  CreateBatchInput,
  CreateBatchResult,
  CreateEntryInput,
  GetByEntityParams,
  ListEntriesParams,
  PaginatedAuditLogEntries,
} from "../types.js";

export const createEntry = async (
  body: CreateEntryInput
): Promise<AuditLogEntry> => {
  const res = await tryHandleRequest<AuditLogEntry>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.audit.create",
      method: "POST",
      url: "/v1/audit/entries",
      data: body,
    },
    "ALS_0001",
    "Failed to create audit log entry"
  );
  return res.data;
};

export const createBatch = async (
  body: CreateBatchInput
): Promise<CreateBatchResult> => {
  const res = await tryHandleRequest<CreateBatchResult>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.audit.createBatch",
      method: "POST",
      url: "/v1/audit/entries/batch",
      data: body,
    },
    "ALS_0002",
    "Failed to create audit log batch"
  );
  return res.data;
};

export const listEntries = async (
  params: ListEntriesParams
): Promise<PaginatedAuditLogEntries> => {
  const res = await tryHandleRequest<PaginatedAuditLogEntries>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.audit.list",
      method: "GET",
      url: "/v1/audit/entries",
      params: params as Record<string, unknown>,
    },
    "ALS_0003",
    "Failed to list audit log entries"
  );
  return res.data;
};

export const getEntry = async (id: string): Promise<AuditLogEntryWithNames> => {
  const res = await tryHandleRequest<AuditLogEntryWithNames>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.audit.get",
      method: "GET",
      url: urlPath`/v1/audit/entries/${id}`,
    },
    "ALS_0004",
    `Failed to fetch audit log entry ${id}`
  );
  return res.data;
};

export const getEntriesByEntity = async (
  entityType: string,
  entityId: string,
  params: GetByEntityParams = {}
): Promise<PaginatedAuditLogEntries> => {
  const res = await tryHandleRequest<PaginatedAuditLogEntries>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.audit.listByEntity",
      method: "GET",
      url: urlPath`/v1/audit/entries/entity/${entityType}/${entityId}`,
      params: params as Record<string, unknown>,
    },
    "ALS_0005",
    `Failed to fetch audit log history for ${entityType} ${entityId}`
  );
  return res.data;
};
