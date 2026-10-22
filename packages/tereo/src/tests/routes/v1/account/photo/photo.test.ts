// @module-tag int
// @module-tag auth

import { DEFAULT_ORGANIZATION_ID } from "../../../../../definitions/index.js";
import { BASE_URL, HTTP_STATUS } from "../../../../support/auth/constants.js";
import { getAccessTokenForUser } from "../../../../support/auth/login.js";
import { createTestClient } from "../../../../support/auth/clients.js";
import { createTestUser } from "../../../../support/auth/users.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import { describe, it, expect, beforeAll } from "vitest";
import {
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../../../../support/webhooks.js";

interface ErrorResponse {
  error?: string;
  error_description?: string;
  message?: string;
  [key: string]: unknown;
}

let testClient: Awaited<ReturnType<typeof createTestClient>>;
let accessToken: string;

beforeAll(async () => {
  testClient = await createTestClient();
  const testUser = await createTestUser({ name: "Test User" });
  accessToken = await getAccessTokenForUser(testUser, testClient);
});

describe("DELETE /v1/account/photo", () => {
  it("should return 404 when no photo exists to delete", async () => {
    const response = await fetch(`${BASE_URL}/v1/account/photo`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
  });

  it("should return 401 with error for request without auth token", async () => {
    const response = await fetch(`${BASE_URL}/v1/account/photo`, {
      method: "DELETE",
    });

    expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);

    const data = (await response.json()) as ErrorResponse;
    expect(data.error).toBeDefined();
  });
});

describe("POST /v1/account/photo", () => {
  it("should reject request without auth token", async () => {
    const response = await fetch(`${BASE_URL}/v1/account/photo`, {
      method: "POST",
    });

    expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
  });

  it("should reject request without photo data", async () => {
    const response = await fetch(`${BASE_URL}/v1/account/photo`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    // Should fail without proper multipart form data
    expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
  });

  it("should return 413 payload_too_large for a photo over the size limit", async () => {
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(5 * 1024 * 1024 + 1)], { type: "image/png" }),
      "big.png"
    );
    const response = await fetch(`${BASE_URL}/v1/account/photo`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      body: form,
    });

    const data = (await response.json()) as ErrorResponse;
    expect(response.status).toBe(HTTP_STATUS.PAYLOAD_TOO_LARGE);
    expect(data.error).toBe("payload_too_large");
  });

  it("should return 413 payload_too_large for too many text fields", async () => {
    const form = new FormData();
    for (let i = 0; i < 50; i++) form.append(`field${i}`, "x");
    form.append(
      "file",
      new Blob([new Uint8Array(16)], { type: "image/png" }),
      "small.png"
    );
    const response = await fetch(`${BASE_URL}/v1/account/photo`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      body: form,
    });

    const data = (await response.json()) as ErrorResponse;
    expect(response.status).toBe(HTTP_STATUS.PAYLOAD_TOO_LARGE);
    expect(data.error).toBe("payload_too_large");
  });

  it("should return 400 invalid_request for an unexpected file field", async () => {
    const form = new FormData();
    form.append(
      "photo",
      new Blob([new Uint8Array(16)], { type: "image/png" }),
      "small.png"
    );
    const response = await fetch(`${BASE_URL}/v1/account/photo`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      body: form,
    });

    const data = (await response.json()) as ErrorResponse;
    expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(data.error).toBe("invalid_request");
  });

  it("sets and removes the photo with an audit entry and auth.user.updated for each", async () => {
    const endpoint = await createTestWebhookEndpoint(
      await getCoreEventSubscriberToken(DEFAULT_ORGANIZATION_ID),
      { eventTypes: ["auth.user.updated"] }
    );
    const photoUser = await createTestUser();
    const where = {
      webhookEndpointId: endpoint.id,
      eventType: "auth.user.updated",
      payload: { path: ["entityId"], equals: photoUser.id },
    };
    const updates = () => prisma.webhookDelivery.count({ where });
    const token = await getAccessTokenForUser(photoUser, testClient);
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(64)], { type: "image/png" }),
      "me.png"
    );

    const upload = await fetch(`${BASE_URL}/v1/account/photo`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    expect(upload.status).toBe(HTTP_STATUS.CREATED);
    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: photoUser.id },
    });
    expect(stored.photoObjectId).toBeTruthy();
    const changed = await prisma.auditLogEntry.findFirst({
      where: {
        entityType: "User",
        entityId: photoUser.id,
        metadata: { path: ["action"], equals: "photo_changed" },
      },
    });
    expect(changed?.metadata).toMatchObject({
      photoObjectId: stored.photoObjectId,
    });
    await waitFor(async () => (await updates()) === 1, 10_000);
    const delivery = await prisma.webhookDelivery.findFirstOrThrow({
      where,
    });
    expect(delivery.payload).toMatchObject({
      entityType: "User",
      data: { id: photoUser.id, email: photoUser.email },
    });

    const remove = await fetch(`${BASE_URL}/v1/account/photo`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(remove.status).toBe(HTTP_STATUS.NO_CONTENT);
    const cleared = await prisma.user.findUniqueOrThrow({
      where: { id: photoUser.id },
    });
    expect(cleared.photoObjectId).toBeNull();
    const removed = await prisma.auditLogEntry.findFirst({
      where: {
        entityType: "User",
        entityId: photoUser.id,
        metadata: { path: ["action"], equals: "photo_removed" },
      },
    });
    expect(removed).not.toBeNull();
    await waitFor(async () => (await updates()) === 2, 10_000);
  });

  it("leaves exactly one photo after concurrent uploads of different types", async () => {
    const photoUser = await createTestUser();
    const token = await getAccessTokenForUser(photoUser, testClient);
    const upload = (type: string, name: string) => {
      const form = new FormData();
      form.append(
        "file",
        new Blob([crypto.getRandomValues(new Uint8Array(64))], { type }),
        name
      );
      return fetch(`${BASE_URL}/v1/account/photo`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
    };

    for (let round = 0; round < 3; round++) {
      const statuses = (
        await Promise.all([
          upload("image/png", "me.png"),
          upload("image/jpeg", "me.jpg"),
        ])
      ).map((r) => r.status);
      expect(statuses).toEqual([HTTP_STATUS.CREATED, HTTP_STATUS.CREATED]);

      const stored = await prisma.user.findUniqueOrThrow({
        where: { id: photoUser.id },
      });
      const live = await prisma.object.findMany({
        where: {
          bucket: { name: "auth-service-user-photos" },
          objectKey: { startsWith: `users/${photoUser.id}/` },
          deletedAt: null,
        },
      });
      expect(live.map((o) => o.id)).toEqual([stored.photoObjectId]);
    }
  });
});
