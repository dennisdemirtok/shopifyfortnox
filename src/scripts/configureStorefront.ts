import { env } from "../config/env";
import { logger } from "../lib/logger";
import { prisma } from "../lib/prisma";
import { shopifyGraphQL } from "../shopify/graphql";

/**
 * Skapar/uppdaterar StorefrontConfig för butiken. Läser butikens verkliga
 * momsinställning ur Shopify så pricesIncludeVat aldrig blir en gissning.
 *
 *   npm run configure:storefront                        # visar vad som skulle sättas
 *   npm run configure:storefront -- --apply             # sparar
 *   npm run configure:storefront -- --apply --freight 3 # ange fraktartikel
 *   flaggor: --auto-bookkeep (låt integrationen bokföra; default av)
 *            --eprint (skicka fakturan som brev i stället för e-post)
 */
const APPLY = process.argv.includes("--apply");
const AUTO_BOOKKEEP = process.argv.includes("--auto-bookkeep");
const EPRINT = process.argv.includes("--eprint");
const fIdx = process.argv.indexOf("--freight");
const FREIGHT = fIdx !== -1 ? process.argv[fIdx + 1] : undefined;

const SHOP_QUERY = /* GraphQL */ `
query ShopTaxSetting {
  shop { name currencyCode taxesIncluded taxShipping }
}`;

async function main() {
  const shopDomain = env.SHOPIFY_SHOP_DOMAIN;

  const data = await shopifyGraphQL<{
    shop: {
      name: string;
      currencyCode: string;
      taxesIncluded: boolean;
      taxShipping: boolean;
    };
  }>(SHOP_QUERY);
  const shop = data.shop;

  logger.info(`Butik: ${shop.name}`);
  logger.info(`  Valuta:              ${shop.currencyCode}`);
  logger.info(`  Priser inkl. moms:   ${shop.taxesIncluded ? "JA" : "NEJ"}`);
  logger.info(`  Moms på frakt:       ${shop.taxShipping ? "JA" : "NEJ"}`);

  const existing = await prisma.storefrontConfig.findUnique({ where: { shopDomain } });

  const desired = {
    shopDomain,
    market: "SE",
    currency: shop.currencyCode,
    b2bModel: "native",
    pricesIncludeVat: shop.taxesIncluded,
    vatRegime: "inhemsk",
    shippingArticleNr: FREIGHT ?? existing?.shippingArticleNr ?? null,
    sendMethod: EPRINT ? "eprint" : "email",
    autoBookkeep: AUTO_BOOKKEEP,
    // Tomma: Fortnox använder sina egna standardkonton och kundens egna
    // betalningsvillkor. Fyll bara i om redovisningen kräver specifika konton.
    paymentTermsMap: {},
    accountMap: {},
    active: true,
  };

  logger.info("── Konfiguration som sätts ──");
  logger.info(`  Fraktartikel:        ${desired.shippingArticleNr ?? "(ingen)"}`);
  logger.info(`  Utskick:             ${desired.sendMethod}`);
  logger.info(`  Bokför automatiskt:  ${desired.autoBookkeep ? "JA" : "NEJ (manuellt i Fortnox)"}`);
  logger.info(`  Försäljningskonton:  (Fortnox standard)`);
  logger.info(`  Betalningsvillkor:   (kundens egna i Fortnox)`);

  if (!APPLY) {
    logger.info("DRY-RUN — inget sparat. Kör med --apply.");
    process.exit(0);
  }

  await prisma.storefrontConfig.upsert({
    where: { shopDomain },
    create: desired,
    update: desired,
  });
  logger.info(existing ? "✓ Konfigurationen uppdaterad." : "✓ Konfigurationen skapad.");
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, "configureStorefront misslyckades");
  process.exit(1);
});
