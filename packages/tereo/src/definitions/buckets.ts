import type { BucketDefinition } from "./types.js";

// Buckets core itself uses. The auth module is the only writer of
// `auth-service-user-photos`; it calls the files module in-process, so no
// per-bucket grant is needed.
export const BUCKETS: BucketDefinition[] = [
  {
    bucketName: "auth-service-user-photos",
    description:
      "User profile photos. Written only by the auth module; read through short-lived presigned URLs it mints.",
    policy: "private",
  },
  {
    bucketName: "auth-service-branding",
    description:
      "Sign-in page branding images. Written only by the branding module; served by /oauth/branding/assets.",
    policy: "private",
    // Released images wait out a grace period in `deleteAfter`.
    managesObjectExpiry: true,
  },
];
