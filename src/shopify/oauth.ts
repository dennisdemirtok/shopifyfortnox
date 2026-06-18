import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { env } from "../config/env";
import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";
import { audit } from "../domain/audit";

const PROVIDER = "shopify";
// Shopify offline-token går inte ut; sätt expiresAt långt fram (fältet är non-null).
const FAR_FUTURE = new Date("2099-01-01T00:00:00Z");

let cachedToken: { shop: string; token: string } | null = null;

function shopifyScopes(): string {
  return env.SHOPIFY_SCOPES;
}

// ── CSRF-state (HMAC-signerat, stateless) ──────────────────────────────────
export function createState(): string {
  const nonce = randomUUID();
  const sig = createHmac("sha256", env.OAUTH_STATE_SECRET).update(nonce).digest("hex");
  return `${nonce}.${sig}`;
}

export function verifyState(state: string | undefined): boolean {
  if (!state || !state.includes(".")) return false;
  const [nonce, sig] = state.split(".");
  if (!nonce || !sig) return false;
  const expected = createHmac("sha256", env.OAUTH_STATE_SECRET).update(nonce).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Bygger Shopifys install-/authorize-URL (offline access token). */
export function buildInstallUrl(state: string, shop = env.SHOPIFY_SHOP_DOMAIN): string {
  const params = new URLSearchParams({
    client_id: env.SHOPIFY_API_KEY,
    scope: shopifyScopes(),
    redirect_uri: `${env.APP_BASE_URL}/oauth/shopify/callback`,
    state,
  });
  return `https://${shop}/admin/oauth/authorize?${params.toString()}`;
}

const SHOP_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;

/** Verifierar HMAC på OAuth-callbackens query-parametrar (signerade med app-secret). */
export function verifyCallbackHmac(query: Record<string, string>): boolean {
  const { hmac, signature, ...rest } = query;
  if (!hmac) return false;
  const message = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join("&");
  const digest = createHmac("sha256", env.SHOPIFY_API_SECRET).update(message).digest("hex");
  const a = Buffer.from(digest);
  const b = Buffer.from(hmac);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isValidShop(shop: string | undefined): shop is string {
  return !!shop && SHOP_RE.test(shop);
}

interface ShopifyTokenResponse {
  access_token: string;
  scope: string;
}

/** Byter authorization code mot ett offline access token och lagrar det. */
export async function exchangeInstallCode(shop: string, code: string): Promise<void> {
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: env.SHOPIFY_API_KEY,
      client_secret: env.SHOPIFY_API_SECRET,
      code,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Shopify token-utbyte ${res.status}: ${text}`);
  }
  const tokens = JSON.parse(text) as ShopifyTokenResponse;

  await prisma.oAuthToken.upsert({
    where: { provider_tenant: { provider: PROVIDER, tenant: shop } },
    create: {
      provider: PROVIDER,
      tenant: shop,
      accessToken: tokens.access_token,
      refreshToken: "", // Shopify offline-token saknar refresh-token
      scope: tokens.scope,
      expiresAt: FAR_FUTURE,
    },
    update: {
      accessToken: tokens.access_token,
      scope: tokens.scope,
      expiresAt: FAR_FUTURE,
      rotatedAt: new Date(),
    },
  });
  cachedToken = { shop, token: tokens.access_token };

  await audit({
    shopDomain: shop,
    flow: "system",
    entityType: "oauth",
    step: "shopify.install",
    status: "ok",
    message: `Appen installerad, scope: ${tokens.scope}`,
  });
  logger.info({ shop }, "Shopify-app installerad (access token sparat).");
}

/**
 * Returnerar ett giltigt Shopify Admin-token. Prioriterar statisk env-token om
 * satt, annars OAuth-token från DB (cachat).
 */
export async function getShopifyAccessToken(
  shop = env.SHOPIFY_SHOP_DOMAIN
): Promise<string> {
  if (env.SHOPIFY_ADMIN_TOKEN && env.SHOPIFY_ADMIN_TOKEN.trim() !== "") {
    return env.SHOPIFY_ADMIN_TOKEN;
  }
  if (cachedToken && cachedToken.shop === shop) return cachedToken.token;
  const row = await prisma.oAuthToken.findUnique({
    where: { provider_tenant: { provider: PROVIDER, tenant: shop } },
  });
  if (!row) {
    throw new Error(
      `Ingen Shopify-token för ${shop}. Installera appen via ${env.APP_BASE_URL}/oauth/shopify/start`
    );
  }
  cachedToken = { shop, token: row.accessToken };
  return row.accessToken;
}

export function clearShopifyTokenCache(): void {
  cachedToken = null;
}

export async function hasShopifyConnection(shop = env.SHOPIFY_SHOP_DOMAIN): Promise<boolean> {
  if (env.SHOPIFY_ADMIN_TOKEN && env.SHOPIFY_ADMIN_TOKEN.trim() !== "") return true;
  const row = await prisma.oAuthToken.findUnique({
    where: { provider_tenant: { provider: PROVIDER, tenant: shop } },
  });
  return !!row;
}
