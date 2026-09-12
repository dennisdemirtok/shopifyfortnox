import "dotenv/config";
import { z } from "zod";

/**
 * Centraliserad, validerad miljökonfiguration.
 * Kastar tidigt (vid uppstart) om något obligatoriskt saknas.
 */
const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : v === "true" || v === "1"));

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  ROLE: z.enum(["web", "worker", "all"]).default("all"),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  APP_BASE_URL: z.string().url(),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  // Fortnox
  FORTNOX_CLIENT_ID: z.string().min(1),
  FORTNOX_CLIENT_SECRET: z.string().min(1),
  FORTNOX_REDIRECT_URI: z.string().url(),
  FORTNOX_SCOPES: z
    .string()
    .default("customer article order invoice bookkeeping companyinformation"),
  FORTNOX_API_BASE: z.string().url().default("https://api.fortnox.se"),
  FORTNOX_AUTH_BASE: z
    .string()
    .url()
    .default("https://apps.fortnox.se/oauth-v1"),
  FORTNOX_RATE_MAX: z.coerce.number().int().positive().default(25),
  FORTNOX_RATE_WINDOW_MS: z.coerce.number().int().positive().default(5000),
  // "service" (spec §6, kräver att godkännaren är systemadministratör i Fortnox)
  // eller "user" (token knyts till den godkännande användaren).
  FORTNOX_ACCOUNT_TYPE: z.enum(["service", "user"]).default("service"),

  // Shopify
  SHOPIFY_SHOP_DOMAIN: z.string().min(1),
  // Valfri: sätts bara om du har en statisk Admin API-token. Annars hämtas token
  // via Shopify OAuth-install (/oauth/shopify/start) och lagras i DB.
  SHOPIFY_ADMIN_TOKEN: z.string().optional(),
  SHOPIFY_API_VERSION: z.string().default("2026-01"),
  // App-hemligheten (Client secret) — krävs för webhook-HMAC och OAuth-token-utbyte.
  SHOPIFY_API_SECRET: z.string().min(1),
  // App client id (från Dev Dashboard) — krävs för OAuth-install.
  SHOPIFY_API_KEY: z.string().min(1),
  SHOPIFY_SCOPES: z
    .string()
    .default("read_companies,write_companies,read_customers,write_customers,read_orders"),

  // Moms / VIES
  VIES_ENABLED: bool(true),
  VIES_ENDPOINT: z
    .string()
    .url()
    .default(
      "https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number"
    ),

  // Larm
  ALERT_EMAIL_TO: z.string().optional(),
  ALERT_EMAIL_FROM: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),

  OAUTH_STATE_SECRET: z.string().min(8),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error(
    "❌ Ogiltig miljökonfiguration:\n",
    JSON.stringify(parsed.error.flatten().fieldErrors, null, 2)
  );
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;

/** Fortnox-scopes som array. */
export const fortnoxScopes = env.FORTNOX_SCOPES.split(/\s+/).filter(Boolean);
