import { bucketRateLimit } from "../../../../../../../../middleware/bucketRateLimit.js";
import { downloadViaSignedUrl, uploadViaSignedUrl } from "./controllers.js";
import { verifySignedObjectUrl } from "./middleware.js";
import { Router } from "express";

const objectRouter = Router({ mergeParams: true });

// `bucketRateLimit` makes presigned traffic count against the same per-bucket
// token bucket as authenticated traffic — otherwise a valid write-presign
// could saturate a bucket's budget without the limiter ever firing. It falls
// open when a bucket has no rateLimitConfig. The signature is checked first,
// so only a bucket name a signer vouched for reaches it.
objectRouter.get(
  "/",
  verifySignedObjectUrl("read"),
  bucketRateLimit,
  downloadViaSignedUrl
);
objectRouter.put(
  "/",
  verifySignedObjectUrl("write"),
  bucketRateLimit,
  uploadViaSignedUrl
);

export default objectRouter;
