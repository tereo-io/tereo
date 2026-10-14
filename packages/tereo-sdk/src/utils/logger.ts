import pino, { LoggerOptions } from "pino";

// Both optional: an app that sets neither still imports the SDK. SERVICE_NAME
// labels the SDK's log lines; it is not the `service` option core knows the
// app by.
const level = process.env.LOG_LEVEL || "info";

const baseOptions: LoggerOptions = {
  level,
  base: { service: process.env.SERVICE_NAME || "@tereo-io/sdk" },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  messageKey: "message",
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
