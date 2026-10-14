import shareRouter from "./share/index.js";
import { Router } from "express";
import express from "express";

/**
 * Public share-link surface. No auth middleware — the token (and optionally
 * the share password) is the only credential.
 *
 * `GET /shared/:token` — 302 redirects to a short-lived presigned URL, or
 *   returns `401 { requiresPassword: true }` when the share has a password.
 * `GET /shared/:token/*` — same as above; the trailing segment is cosmetic
 *   (it's how custom URL filenames are surfaced to end users).
 * `HEAD /shared/:token` (and `/:token/*`) — status probe: 200 with the
 *   file's details in headers, 401 for a password share, uniform 404. Never
 *   counts a download.
 * `POST /shared/:token/unlock { password }` — rate-limited; on success
 *   returns `{ url, expiresAt }` pointing at a short-lived presigned URL.
 */
const sharedRouter = Router();

// Parse JSON bodies here specifically — the global parser is applied above
// in app.ts already, but keep this self-contained so a future rearrangement
// doesn't accidentally drop body parsing for the unlock endpoint.
sharedRouter.use(express.json({ limit: "1mb" }));

sharedRouter.use("/:token", shareRouter);

export default sharedRouter;
