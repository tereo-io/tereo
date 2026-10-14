import { createRequireAuth } from "../../../middleware/auth.js";
import filesSignedRouter from "./signed/index.js";
import filesSharedRouter from "./shared/index.js";
import bucketsRouter from "./buckets/index.js";
import { parseBody } from "./middleware.js";
import { Router } from "express";
import helmet from "helmet";
import {
  accessLogErrorFallback,
  accessLogMiddleware,
} from "../../../middleware/accessLog.js";
import {
  rateLimitGeneral,
  rateLimitPreAuth,
} from "../../../middleware/rateLimit.js";

// Patterns match `req.path`, relative to the /v1/files mount, and admit only a
// GET or HEAD that carries no Authorization header; a request with one is
// always authenticated.
//
// Admission does not decide whether the response is served. The read
// controllers behind these paths call `getReadableBucket` (utils/bucketAccess),
// which serves a public bucket to anyone and otherwise needs a token (401)
// and then read access (403), private and missing buckets alike.
//
// What is admitted: the object list (`/objects`); under PUBLIC_OBJECT_KEY,
// key-addressed download and HEAD and also `/objects/prefixes`, whose literal
// segment the pattern can't tell from a key; `/objects/by-key/...`; and
// `/objects/by-id/:id` with its versions (list, one version, its download).
// `/by-id/:id/presign` is left out by the patterns. None of these routes adds
// `requirePermission`, which would need a token even on a public bucket.
const PUBLIC_OBJECT_KEY = /^\/buckets\/[^/]+\/objects\/(?!by-id\/|by-key\/).+$/;
const PUBLIC_BY_KEY = /^\/buckets\/[^/]+\/objects\/by-key\/.+$/;
const PUBLIC_BY_ID = /^\/buckets\/[^/]+\/objects\/by-id\/[^/]+$/;
const PUBLIC_BY_ID_VERSIONS =
  /^\/buckets\/[^/]+\/objects\/by-id\/[^/]+\/versions(?:\/[^/]+(?:\/download)?)?$/;
const PUBLIC_OBJECT_LIST = /^\/buckets\/[^/]+\/objects$/;

const requireAuth = createRequireAuth({
  area: "files",
  publicRoutes: [
    { pattern: PUBLIC_OBJECT_LIST },
    { pattern: PUBLIC_OBJECT_KEY },
    { pattern: PUBLIC_BY_KEY },
    { pattern: PUBLIC_BY_ID },
    { pattern: PUBLIC_BY_ID_VERSIONS },
  ],
});

const router = Router();

// Cross-origin resource policy is relaxed so browsers can load presigned and
// shared downloads from other origins.
router.use(helmet.crossOriginResourcePolicy({ policy: "cross-origin" }));
router.use(accessLogMiddleware);

// Signed URLs and share links carry their own credential (an HMAC, or the
// share token and optional password), so they are mounted before
// authentication. The global limiter still bounds them: without it, token
// probing and replay of leaked signed URLs would be unthrottled. Signed URLs
// take no parsed body: a presigned PUT streams its raw bytes.
router.use("/signed", rateLimitGeneral, filesSignedRouter);
router.use(parseBody);
router.use("/shared", rateLimitGeneral, filesSharedRouter);

router.use(rateLimitPreAuth);
router.use(requireAuth);
router.use(rateLimitGeneral);

router.use("/buckets", bucketsRouter);

// Writes a fallback access-log entry for requests that error before a
// controller calls `setAccessLog`. Must run before the error handler.
router.use(accessLogErrorFallback);

export default router;
