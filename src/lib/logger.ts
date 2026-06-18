import pino from "pino";
import { env } from "../config/env";

const isDev = env.NODE_ENV === "development";

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: "iae-shopify-fortnox" },
  redact: {
    paths: [
      "*.accessToken",
      "*.refreshToken",
      "*.access_token",
      "*.refresh_token",
      "req.headers.authorization",
      'req.headers["x-shopify-access-token"]',
      "*.SHOPIFY_ADMIN_TOKEN",
      "*.FORTNOX_CLIENT_SECRET",
      "*.client_secret",
    ],
    censor: "[REDACTED]",
  },
  transport: isDev
    ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:standard" } }
    : undefined,
});

export type Logger = typeof logger;
