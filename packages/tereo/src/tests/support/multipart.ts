import { BASE_URL, HTTP_STATUS, testIdempotencyKey } from "./files.js";
import type { Readable } from "stream";
import { randomBytes } from "crypto";
import { expect } from "vitest";
import axios from "axios";

/** Requests against one bucket's multipart routes, as the user holding `token`. */
export const multipartClient = (
  ctx: () => { token: string; bucketName: string }
) => {
  // Content a complete's file-type check accepts, as random bytes may not be.
  const text = () => Buffer.from(`part ${randomBytes(16).toString("hex")}`);

  const as = (t = ctx().token) => ({
    headers: { Authorization: `Bearer ${t}` },
    validateStatus: () => true,
  });

  const initiate = async (t = ctx().token) => {
    const res = await axios.post(
      `${BASE_URL}/buckets/${ctx().bucketName}/multipart`,
      {
        objectKey: `mp-${randomBytes(4).toString("hex")}.bin`,
        contentType: "application/octet-stream",
      },
      as(t)
    );
    expect(res.status).toBe(HTTP_STATUS.CREATED);
    return res.data.uploadId as string;
  };

  const putPart = (
    uploadId: string,
    partNumber: number,
    body: Buffer | Readable
  ) =>
    axios.put(
      `${BASE_URL}/buckets/${ctx().bucketName}/multipart/${uploadId}/parts/${partNumber}`,
      body,
      {
        headers: {
          Authorization: `Bearer ${ctx().token}`,
          "Content-Type": "application/octet-stream",
        },
        validateStatus: () => true,
        maxBodyLength: Infinity,
      }
    );

  const complete = (
    uploadId: string,
    parts: Array<{ partNumber: number; etag: string }>
  ) =>
    axios.post(
      `${BASE_URL}/buckets/${ctx().bucketName}/multipart/${uploadId}/complete`,
      { parts },
      {
        headers: {
          Authorization: `Bearer ${ctx().token}`,
          "Idempotency-Key": testIdempotencyKey(),
        },
        validateStatus: () => true,
      }
    );

  return { text, as, initiate, putPart, complete };
};
