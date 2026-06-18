import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config/env";

/**
 * Verifierar Shopifys webhook-HMAC (X-Shopify-Hmac-Sha256).
 * MÅSTE köras mot den RÅA request-bodyn (inte JSON-parsad), med app-hemligheten.
 */
export function verifyShopifyHmac(
  rawBody: Buffer,
  hmacHeader: string | undefined
): boolean {
  if (!hmacHeader) return false;
  const digest = createHmac("sha256", env.SHOPIFY_API_SECRET)
    .update(rawBody)
    .digest("base64");
  const a = Buffer.from(digest);
  const b = Buffer.from(hmacHeader);
  return a.length === b.length && timingSafeEqual(a, b);
}
