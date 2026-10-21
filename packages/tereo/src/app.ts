import { createRequestIdMiddleware } from "./utils/requestId.js";
import { errorHandler, NotFoundError } from "./utils/errors.js";
import { authRequestLog } from "./middleware/authRequestLog.js";
import { rateLimitPreflight } from "./middleware/rateLimit.js";
import { bucketCors } from "./middleware/bucketCors.js";
import { apiCors } from "./middleware/apiCors.js";
import routes from "./routes/index.js";
import express from "express";
import helmet from "helmet";
import env from "./env.js";

const app = express();

// Express's `req.ip` resolves through `X-Forwarded-For` only when this is
// configured. Without it, every IP-keyed limiter (credential/TOTP failures,
// share unlock) keys on a client-supplied header an attacker can rotate per
// request, and access-log IPs are wrong. Numeric strings become hop counts
// ("1" → one upstream proxy) rather than the literal IP "1"; "true"/"false"
// toggle trust-everything/nothing; anything else (e.g. "loopback", a CIDR
// list) is passed through verbatim.
const trustProxy = /^\d+$/.test(env.TRUST_PROXY)
  ? Number(env.TRUST_PROXY)
  : env.TRUST_PROXY === "true"
    ? true
    : env.TRUST_PROXY === "false"
      ? false
      : env.TRUST_PROXY;
app.set("trust proxy", trustProxy);

app.use(createRequestIdMiddleware());

// Also the admin UI's policy, served from the root: its scripts are files (no
// inline script), it styles inline, previews images from blob: URLs, and
// talks to the API and the /ws socket on this origin.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        baseUri: ["'self'"],
        // Over plain http (local compose) upgrading would point the UI's own
        // assets at an https port that isn't there.
        upgradeInsecureRequests: env.PUBLIC_URL.startsWith("https:")
          ? []
          : null,
      },
    },
  })
);

// A bucket's own CORS config answers preflights for its object routes. The
// global middleware below ends every preflight itself, so this goes first;
// a bucket without a config falls through to it. Preflights carry no token,
// so they have their own per-IP limit.
app.options(
  [
    "/v1/files/buckets/:name/objects{/*rest}",
    "/v1/files/buckets/:name/archives{/*rest}",
    "/v1/files/buckets/:name/multipart{/*rest}",
  ],
  rateLimitPreflight,
  bucketCors
);

app.use(apiCors);

// Logged for /oauth and /v1/admin, before the routes answer.
app.use(authRequestLog);

app.use(routes);

app.use(() => {
  throw new NotFoundError("Not found");
});

app.use(errorHandler);

export default app;
