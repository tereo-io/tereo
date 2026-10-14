import env from "@/lib/env";

// Copied into public/ by `npm run openapi:sync`; relative to the app's base
// path, so it resolves wherever the build is served.
export const SPEC_URL = `${env.HOME_PATH}openapi/tereo.yaml`;
