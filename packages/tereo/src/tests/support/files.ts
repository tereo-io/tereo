import { ensureTestMembership, getTestPrincipalToken } from "./principals.js";
import { prisma } from "../../utils/db/prisma.js";
import { randomBytes, randomUUID } from "crypto";
import { CORE_URL } from "./coreUrl.js";
import FormData from "form-data";
import axios from "axios";

/** Generate a fresh idempotency key for test uploads. */
export const testIdempotencyKey = (): string => randomUUID();

export const BASE_URL = `${CORE_URL}/v1/files`;

// HTTP Status Code Constants for consistent test assertions
export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  INTERNAL_SERVER_ERROR: 500,
  INSUFFICIENT_STORAGE: 507,
} as const;

// Test entity tracking for cleanup
// Only track buckets since we clean up all objects/permissions/logs via pattern matching
const testBucketIds: number[] = [];

export function generateUniqueId(): string {
  return randomBytes(8).toString("hex");
}

/**
 * Create a test bucket
 * Requires authenticated token
 */
export async function createTestBucket(
  token: string,
  options: {
    name?: string;
    description?: string;
    policy?: "public" | "private";
    storageQuotaBytes?: string | null;
  } = {}
) {
  const uniqueId = generateUniqueId();
  const bucketName = options.name || `test-bucket-${uniqueId}`;

  const response = await axios.post(
    `${BASE_URL}/buckets`,
    {
      name: bucketName,
      description: options.description || "Test bucket",
      policy: options.policy || "private",
      storageQuotaBytes: options.storageQuotaBytes,
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      validateStatus: () => true, // Don't throw on any status
    }
  );

  if (response.status !== 201) {
    throw new Error(
      `Failed to create test bucket: ${response.status} ${JSON.stringify(
        response.data
      )}`
    );
  }

  const data = response.data;
  testBucketIds.push(data.id);

  return data;
}

/**
 * Create a test file buffer
 */
// Canonical magic-byte prefixes for binary file types. `validateMimeType`
// uses `fileTypeFromFile` against the disk-staged multer file, which needs
// more than the raw 8-byte signature for PNG detection — it reads the first
// chunk (IHDR) to confirm the container. So for PNG we emit a full minimal
// 1x1 PNG header (signature + IHDR). `fileTypeFromFile` only inspects the
// first ~20 bytes, so the rest of the test buffer may be anything.
const PNG_HEADER = Buffer.from([
  // 8-byte PNG signature
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  // IHDR chunk length (13 bytes)
  0x00, 0x00, 0x00, 0x0d,
  // IHDR chunk type
  0x49, 0x48, 0x44, 0x52,
  // width=1, height=1, bitDepth=8, colorType=0, compression=0, filter=0, interlace=0
  0x00,
  0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x00, 0x00, 0x00, 0x00,
  // CRC-32 of the IHDR chunk type+data
  0x3a, 0x7e, 0x9b, 0x55,
]);

const BINARY_MAGIC_BYTES: Record<string, Buffer> = {
  "image/png": PNG_HEADER,
};

export function createTestFile(
  content: string = "test file content",
  filename: string = "test.txt",
  contentType: string = "text/plain"
): { buffer: Buffer; filename: string; contentType: string } {
  const magic = BINARY_MAGIC_BYTES[contentType];
  const buffer = magic
    ? Buffer.concat([magic, Buffer.from(content)])
    : Buffer.from(content);
  return {
    buffer,
    filename,
    contentType,
  };
}

/**
 * Upload an object to a bucket
 */
export async function uploadTestObject(
  token: string,
  bucketName: string,
  objectKey: string,
  file: { buffer: Buffer; filename: string; contentType: string }
) {
  const formData = new FormData();
  formData.append("file", file.buffer, {
    filename: file.filename,
    contentType: file.contentType,
  });

  const response = await axios.put(
    `${BASE_URL}/buckets/${bucketName}/objects/${objectKey}`,
    formData,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Idempotency-Key": testIdempotencyKey(),
        ...formData.getHeaders(),
      },
      validateStatus: () => true,
    }
  );

  if (response.status !== 201 && response.status !== 200) {
    throw new Error(
      `Failed to upload test object: ${response.status} ${JSON.stringify(
        response.data
      )}`
    );
  }

  return response.data as { id: string; key: string; [k: string]: unknown };
}

/**
 * Upload and return just the object's UUID id. Thin convenience over
 * `uploadTestObject` for tests that follow up with id-addressed routes
 * (DELETE, versions, presign, PATCH).
 */
export async function uploadTestObjectAndGetId(
  token: string,
  bucketName: string,
  objectKey: string,
  file: { buffer: Buffer; filename: string; contentType: string }
): Promise<string> {
  const result = await uploadTestObject(token, bucketName, objectKey, file);
  return result.id;
}

/**
 * Grant bucket permission to a user
 */
export async function grantTestPermission(
  token: string,
  bucketName: string,
  userId: string,
  permissions: { canRead?: boolean; canWrite?: boolean; canDelete?: boolean }
) {
  const response = await axios.post(
    `${BASE_URL}/buckets/${bucketName}/permissions`,
    {
      userId,
      canRead: permissions.canRead ?? true,
      canWrite: permissions.canWrite ?? false,
      canDelete: permissions.canDelete ?? false,
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      validateStatus: () => true,
    }
  );

  if (response.status !== 201) {
    throw new Error(
      `Failed to grant test permission: ${response.status} ${JSON.stringify(
        response.data
      )}`
    );
  }

  return response.data;
}

/**
 * A real access token for a test user holding `file-service.admin`.
 * See `tests/utils/principals.ts`.
 */
export function getTestAccessToken(
  userId: string = "00000000-0000-7001-0000-000000000001"
): Promise<string> {
  return getTestPrincipalToken({
    userId,
    permissions: ["file-service.admin"],
  });
}

/** The default test user — a fixture created by globalSetup. */
export function getTestUserId(): string {
  return "00000000-0000-7001-0000-000000000001";
}

/**
 * Cleanup all test entities
 * Called after tests to remove test data
 *
 * This function performs a comprehensive cleanup that includes:
 * 1. Only buckets tracked by THIS test suite (not all test buckets)
 * 2. All associated objects, permissions, and access logs
 * 3. Physical storage files
 *
 * NOTE: We only clean up tracked buckets to avoid interfering with
 * other test suites running in parallel.
 */
export async function cleanupTestEntities() {
  await removeBuckets(testBucketIds);
  testBucketIds.length = 0;
}

/**
 * Global cleanup for all test entities
 * Should only be called in global teardown after all tests complete
 * Cleans up any leftover test buckets (e.g., from failed tests)
 */
export async function cleanupAllTestEntities() {
  const allTestBuckets = await prisma.bucket.findMany({
    where: { name: { startsWith: "test-bucket-" } },
    select: { id: true },
  });
  await removeBuckets(allTestBuckets.map((b) => b.id));
}

/**
 * Deletes the buckets with their objects, and each content blob no longer
 * referenced, row and file. A blob row left behind outlives the run: the next
 * upload of the same content shares it, so its file must stay readable.
 */
export async function removeBuckets(bucketIds: number[]) {
  if (bucketIds.length === 0) return;
  const fs = await import("fs/promises");

  const versions = await prisma.objectVersion.findMany({
    where: { object: { bucketId: { in: bucketIds } } },
    select: { contentBlobHash: true },
  });
  const hashes = new Set(
    versions
      .map((v) => v.contentBlobHash)
      .filter((h): h is string => h !== null)
  );

  // Cascade wipe: buckets → objects → versions + access logs + multipart rows.
  await prisma.bucketPermission
    .deleteMany({ where: { bucketId: { in: bucketIds } } })
    .catch(() => {});
  await prisma.bucket
    .deleteMany({ where: { id: { in: bucketIds } } })
    .catch(() => {});

  for (const hash of hashes) {
    try {
      const stillReferenced = await prisma.objectVersion.count({
        where: { contentBlobHash: hash },
      });
      if (stillReferenced === 0) {
        const blob = await prisma.contentBlob.findUnique({ where: { hash } });
        if (blob) {
          await fs.unlink(blob.fsPath).catch(() => {});
          await prisma.contentBlob.delete({ where: { hash } }).catch(() => {});
        }
      }
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Create FormData with file and optional metadata
 */
export function createFormDataWithMetadata(
  file: { buffer: Buffer; filename: string; contentType: string },
  metadata?: Record<string, string>
): { formData: FormData; headers: Record<string, string> } {
  const formData = new FormData();
  formData.append("file", file.buffer, {
    filename: file.filename,
    contentType: file.contentType,
  });

  const headers: Record<string, string> = {};
  if (metadata) {
    headers["X-Metadata"] = JSON.stringify(metadata);
  }

  return { formData, headers };
}

/**
 * Wait for a condition to be true
 * Useful for testing eventual consistency
 */
export async function waitFor(
  condition: () => Promise<boolean>,
  timeout: number = 5000,
  interval: number = 100
): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new Error("Timeout waiting for condition");
}

const MEMBER = [
  "file-service.buckets.delete",
  "file-service.objects.delete",
  "file-service.permissions.delete",
  "file-service.shares.delete",
];

const ORG = "bucket-owner-access-org";

const as = (token?: string) => ({
  headers: token ? { Authorization: `Bearer ${token}` } : {},
  validateStatus: () => true,
});

/** A user in ORG holding MEMBER, and a token for it. */
const member = async (permissions = MEMBER) => {
  const userId = randomUUID();
  await ensureTestMembership(userId, ORG);
  const token = await getTestPrincipalToken({
    userId,
    organizationId: ORG,
    permissions,
  });
  return { userId, token };
};

const grant = (
  token: string,
  bucketName: string,
  userId: string,
  flags: { canRead?: boolean; canWrite?: boolean; canDelete?: boolean }
) =>
  axios.post(
    `${BASE_URL}/buckets/${bucketName}/permissions`,
    {
      userId,
      canRead: flags.canRead ?? false,
      canWrite: flags.canWrite ?? false,
      canDelete: flags.canDelete ?? false,
    },
    as(token)
  );

/**
 * The bucket-owner access tests' organization, the role permissions its
 * members hold, and their helpers, shared by every file that uses them.
 */
export const bucketOwnerAccess = { MEMBER, ORG, as, member, grant };
