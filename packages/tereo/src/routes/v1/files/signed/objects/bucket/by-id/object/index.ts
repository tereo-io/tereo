import { bucketRateLimit } from "../../../../../../../../middleware/bucketRateLimit.js";
import { verifySignedObjectUrl } from "./middleware.js";
import { Router } from "express";
import {
  downloadViaSignedUrl,
  probeViaSignedUrl,
  uploadViaSignedUrl,
} from "./controllers.js";

const objectRouter = Router({ mergeParams: true });

// `bucketRateLimit` makes presigned traffic count against the same per-bucket
// token bucket as authenticated traffic — otherwise a valid write-presign
// could saturate a bucket's budget without the limiter ever firing. It falls
// open when a bucket has no rateLimitConfig. The signature is checked first,
// so only a bucket name a signer vouched for reaches it.
// HEAD before GET: Express otherwise answers HEAD with the GET handler, which
// would spend a capped share's single-use URL.
objectRouter.head(
  "/",
  verifySignedObjectUrl("read"),
  bucketRateLimit,
  probeViaSignedUrl
);
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
