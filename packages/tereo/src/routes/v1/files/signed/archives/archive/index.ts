import { downloadArchiveViaSignedUrl } from "./controllers.js";
import { Router } from "express";

const archiveRouter = Router({ mergeParams: true });

// Bucket-rate-limit cannot be applied here without an extra DB roundtrip (the
// URL doesn't carry the bucket name), so the handler itself resolves the
// bucket via the ArchiveRequest row before it starts streaming. Rate limit is
// best-effort on the create side.
archiveRouter.get("/", downloadArchiveViaSignedUrl);

export default archiveRouter;
