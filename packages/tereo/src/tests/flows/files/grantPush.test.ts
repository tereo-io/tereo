// @module-tag int
// @module-tag files
import { afterAll, describe, expect, it } from "vitest";
import { CORE_URL } from "../../support/coreUrl.js";
import { randomUUID } from "crypto";
import axios from "axios";
import {
  ensureTestMembership,
  getTestPrincipalToken,
} from "../../support/principals.js";
import {
  BASE_URL,
  cleanupTestEntities,
  createTestBucket,
} from "../../support/files.js";

describe("grant changes pushed over the websocket", () => {
  // Everything a bucket owner does, but no `file-service.admin`.
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

  const revoke = (token: string, bucketName: string, userId: string) =>
    axios.delete(
      `${BASE_URL}/buckets/${bucketName}/permissions/${userId}`,
      as(token)
    );

  afterAll(async () => {
    await cleanupTestEntities();
  });

  describe("websocket push", () => {
    /** A socket.io client over a plain WebSocket, collecting events. */
    const connect = (token: string) => {
      const ws = new WebSocket(
        `${CORE_URL.replace(/^http/, "ws")}/ws/?EIO=4&transport=websocket`
      );
      const events: { name: string; payload: unknown }[] = [];
      const connected = new Promise<void>((resolve, reject) => {
        ws.addEventListener("message", ({ data }) => {
          const packet = String(data);
          if (packet.startsWith("0")) ws.send(`40${JSON.stringify({ token })}`);
          else if (packet === "2") ws.send("3");
          else if (packet.startsWith("40")) resolve();
          else if (packet.startsWith("44")) reject(new Error(packet));
          else if (packet.startsWith("42")) {
            const [name, payload] = JSON.parse(packet.slice(2)) as [
              string,
              unknown,
            ];
            events.push({ name, payload });
          }
        });
        ws.addEventListener("close", () => reject(new Error("closed")));
      });
      return { connected, events, close: () => ws.close() };
    };

    const received = async (
      events: { name: string; payload: unknown }[],
      count: number
    ) => {
      const deadline = Date.now() + 5000;
      const matching = () =>
        events.filter((e) => e.name === "files:bucket-access:changed");
      while (matching().length < count && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      return matching();
    };

    it("tells the user whose grant was given or revoked", async () => {
      const owner = await member();
      const reader = await member();
      const bucket = await createTestBucket(owner.token);
      const socket = connect(reader.token);
      try {
        await socket.connected;
        await grant(owner.token, bucket.name, reader.userId, { canRead: true });
        await revoke(owner.token, bucket.name, reader.userId);

        const events = await received(socket.events, 2);
        expect(events).toHaveLength(2);
        expect(events[0].payload).toMatchObject({ bucketName: bucket.name });
      } finally {
        socket.close();
      }
    });
  });
});
