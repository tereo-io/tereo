import { Router } from "express";
import {
  downloadArchiveViaSignedUrl,
  probeArchiveViaSignedUrl,
} from "./controllers.js";

const archiveRouter = Router({ mergeParams: true });

// Bucket-rate-limit cannot be applied here without an extra DB roundtrip (the
// URL doesn't carry the bucket name), so the handler itself resolves the
// bucket via the ArchiveRequest row before it starts streaming. Rate limit is
// best-effort on the create side.
// HEAD before GET: Express otherwise answers HEAD with the GET handler, which
// would spend a capped share's single-use URL.
archiveRouter.head("/", probeArchiveViaSignedUrl);
archiveRouter.get("/", downloadArchiveViaSignedUrl);

export default archiveRouter;
