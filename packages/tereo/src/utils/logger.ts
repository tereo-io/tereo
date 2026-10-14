import { getRequestId } from "./requestId.js";
import pino, { LoggerOptions } from "pino";

if (!process.env.LOG_LEVEL) {
  throw new Error("LOG_LEVEL is not defined in environment variables");
}

if (!process.env.SERVICE_NAME) {
  throw new Error("SERVICE_NAME is not defined in environment variables");
}

/** Tags every line logged during a request with its id. */
export const requestIdMixin = (): { request_id?: string } => {
  const requestId = getRequestId();
  return requestId ? { request_id: requestId } : {};
};

const isSilent = process.env.LOG_LEVEL === "silent";

const baseOptions: LoggerOptions = {
  level: isSilent ? "silent" : process.env.LOG_LEVEL,
  base: { service: process.env.SERVICE_NAME },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  messageKey: "message",
  mixin: () => requestIdMixin(),
};

const pinoOptions: LoggerOptions =
  process.env.NODE_ENV === "production"
    ? baseOptions
    : {
        ...baseOptions,
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "yyyy-mm-dd HH:MM:ss",
            ignore: "pid,hostname",
            messageKey: "message",
          },
        },
      };

export const logger = pino(pinoOptions);
export type Logger = typeof logger;
