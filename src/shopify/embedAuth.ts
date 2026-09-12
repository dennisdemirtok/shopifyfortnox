import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config/env";

/**
 * Autentisering för den inbäddade adminvyn i Shopify.
 *
 * Shopify laddar appen i en iframe och skickar med antingen en session-token
 * (`id_token`, en JWT signerad med appens client secret) eller en `hmac` över
 * query-parametrarna. Vi accepterar båda — då fungerar vyn oavsett vilken
 * variant Shopify-versionen använder.
 *
 * Åtkomsten styrs därmed av Shopifys egna personalkonton: ser användaren appen
 * i admin får hen in, annars inte. Ingen delad hemlig länk behövs.
 */

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function b64urlToBuf(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export interface SessionInfo {
  shop: string;
}

/** Verifierar Shopifys session-token (JWT, HS256 med client secret). */
export function verifySessionToken(idToken: string): SessionInfo | null {
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts as [string, string, string];

  const expected = createHmac("sha256", env.SHOPIFY_API_SECRET)
    .update(`${header}.${payload}`)
    .digest("base64url");
  if (!safeEqual(signature, expected)) return null;

  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(b64urlToBuf(payload).toString("utf8"));
  } catch {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp === "number" && claims.exp < now) return null;
  if (typeof claims.nbf === "number" && claims.nbf > now + 60) return null;
  // aud måste vara vår app.
  if (claims.aud !== env.SHOPIFY_API_KEY) return null;

  // dest = "https://butiken.myshopify.com"
  const dest = typeof claims.dest === "string" ? claims.dest : "";
  const shop = dest.replace(/^https?:\/\//, "");
  if (!shop.endsWith(".myshopify.com")) return null;
  if (shop.toLowerCase() !== env.SHOPIFY_SHOP_DOMAIN.toLowerCase()) return null;

  return { shop };
}

/** Verifierar HMAC över query-parametrarna (äldre inbäddningsvariant). */
export function verifyQueryHmac(query: Record<string, string>): boolean {
  const { hmac, signature, ...rest } = query;
  if (!hmac) return false;
  const message = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join("&");
  const digest = createHmac("sha256", env.SHOPIFY_API_SECRET)
    .update(message)
    .digest("hex");
  return safeEqual(digest, hmac);
}

/** Godkänner en inbäddad sidladdning via session-token ELLER query-HMAC. */
export function verifyEmbeddedRequest(
  query: Record<string, string>
): SessionInfo | null {
  const idToken = query.id_token ?? query.session;
  if (idToken) {
    const info = verifySessionToken(idToken);
    if (info) return info;
  }
  if (verifyQueryHmac(query)) {
    const shop = query.shop ?? env.SHOPIFY_SHOP_DOMAIN;
    if (shop.toLowerCase() === env.SHOPIFY_SHOP_DOMAIN.toLowerCase()) return { shop };
  }
  return null;
}

// ── Kortlivad formulärtoken ───────────────────────────────────────────────
// Utfärdas först efter en verifierad inbäddad sidladdning och följer med
// formulärposterna, så att POST inte kan göras utan att ha sett sidan.
const FORM_TOKEN_TTL_MS = 60 * 60 * 1000;

export function issueFormToken(shop: string): string {
  const exp = Date.now() + FORM_TOKEN_TTL_MS;
  const payload = `${shop}.${exp}`;
  const sig = createHmac("sha256", env.OAUTH_STATE_SECRET).update(payload).digest("hex");
  return `${Buffer.from(payload).toString("base64url")}.${sig}`;
}

export function verifyFormToken(token: string | undefined): SessionInfo | null {
  if (!token || !token.includes(".")) return null;
  const [encoded, sig] = token.split(".") as [string, string];
  let payload: string;
  try {
    payload = b64urlToBuf(encoded).toString("utf8");
  } catch {
    return null;
  }
  const expected = createHmac("sha256", env.OAUTH_STATE_SECRET)
    .update(payload)
    .digest("hex");
  if (!safeEqual(sig, expected)) return null;

  const [shop, expStr] = payload.split(".") as [string, string];
  if (!shop || Number(expStr) < Date.now()) return null;
  if (shop.toLowerCase() !== env.SHOPIFY_SHOP_DOMAIN.toLowerCase()) return null;
  return { shop };
}
