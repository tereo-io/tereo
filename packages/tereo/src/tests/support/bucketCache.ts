import type { Request, Response } from "express";
import {
  broadcastBucketInvalidate,
  onBucketInvalidate,
} from "../../utils/cacheBroadcast.js";

export const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

export const fakeRes = () => {
  const headers: Record<string, unknown> = {};
  const res = {
    setHeader: (k: string, v: unknown) => {
      headers[k.toLowerCase()] = v;
    },
    removeHeader: (k: string) => {
      delete headers[k.toLowerCase()];
    },
    status: () => res,
    end: () => {},
  } as unknown as Response;
  return { res, headers };
};

export const ORIGIN = "https://new.example";

export const fakeReq = (name: string) =>
  ({
    params: { name },
    headers: { origin: ORIGIN },
    method: "GET",
    ip: "203.0.113.1",
  }) as unknown as Request;

/** Resolves once this process has received an invalidation for `name`. */
const invalidationArrived = (name: string) => {
  const seen = deferred<void>();
  onBucketInvalidate((n) => {
    if (n === name) seen.resolve();
  });
  return seen.promise;
};

export const invalidate = async (name: string) => {
  const arrived = invalidationArrived(name);
  await broadcastBucketInvalidate(name);
  await arrived;
};
