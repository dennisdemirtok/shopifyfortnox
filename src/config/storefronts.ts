import { prisma } from "../lib/prisma";
import { env } from "./env";

/** Upplöst storefront-konfig (spec §11). DB-rad eller defaults för piloten. */
export interface ResolvedStorefront {
  shopDomain: string;
  market?: string;
  currency: string;
  b2bModel: "native" | "tagged";
  pricesIncludeVat: boolean;
  vatRegime: string;
  shippingArticleNr?: string;
  sendMethod: "email" | "eprint";
  autoBookkeep: boolean;
  taggedB2bTag?: string;
  paymentTermsMap: Record<string, string>;
  accountMap: Record<string, string | number>;
}

function asRecord(v: unknown): Record<string, string> {
  return v && typeof v === "object" ? (v as Record<string, string>) : {};
}
function asAccountMap(v: unknown): Record<string, string | number> {
  return v && typeof v === "object" ? (v as Record<string, string | number>) : {};
}

/**
 * Hämtar konfig för en storefront. Saknas DB-rad används säkra defaults för den
 * enda konfigurerade butiken (piloten) så systemet funkar direkt efter deploy.
 */
export async function getStorefrontConfig(
  shopDomain: string
): Promise<ResolvedStorefront> {
  const row = await prisma.storefrontConfig.findUnique({ where: { shopDomain } });
  if (row) {
    return {
      shopDomain: row.shopDomain,
      market: row.market ?? undefined,
      currency: row.currency,
      b2bModel: (row.b2bModel as "native" | "tagged") ?? "native",
      pricesIncludeVat: row.pricesIncludeVat,
      vatRegime: row.vatRegime,
      shippingArticleNr: row.shippingArticleNr ?? undefined,
      sendMethod: (row.sendMethod as "email" | "eprint") ?? "email",
      autoBookkeep: row.autoBookkeep,
      taggedB2bTag: row.taggedB2bTag ?? undefined,
      paymentTermsMap: asRecord(row.paymentTermsMap),
      accountMap: asAccountMap(row.accountMap),
    };
  }

  return {
    shopDomain,
    currency: "SEK",
    b2bModel: "native",
    pricesIncludeVat: false, // B2B-priser normalt exkl. moms (spec §5) — verifiera per storefront
    vatRegime: "inhemsk",
    sendMethod: "email",
    // Bokföring sköts normalt manuellt i Fortnox av redovisningsansvarig.
    autoBookkeep: false,
    paymentTermsMap: {},
    accountMap: {},
  };
}

/** Den enda storefront som är konfigurerad via env (piloten). */
export function defaultShopDomain(): string {
  return env.SHOPIFY_SHOP_DOMAIN;
}
