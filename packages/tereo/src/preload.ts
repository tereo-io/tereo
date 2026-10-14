import "dotenv/config";

// Side-effect module: must be the first import of every entry point (server,
// seed, CLI, tests). `utils/logger.ts` reads LOG_LEVEL and SERVICE_NAME when it
// loads and throws if either is unset, so they have to be in place before
// anything imports it. The service-registry register hook
// used to set them; there is one service now, so the name is a constant.
process.env.SERVICE_NAME = "tereo";
process.env.LOG_LEVEL ??= "info";
