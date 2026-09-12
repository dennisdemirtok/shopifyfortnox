import { env } from "../config/env";
import { logger } from "../lib/logger";
import { prisma } from "../lib/prisma";
import { createArticle, getArticle, updateArticle } from "../fortnox/client";
import { listAllProducts, type ShopifyVariant } from "../shopify/data";
import { audit } from "../domain/audit";

/**
 * Produktsynk Shopify → Fortnox: varje variant med SKU speglas som en artikel
 * i Fortnox (ArticleNumber = SKU). Det gör att Flöde B slipper stoppa på
 * "okänd SKU" när en order ska faktureras.
 *
 *   npm run sync:products                  # DRY-RUN
 *   npm run sync:products -- --apply       # skapar/uppdaterar på riktigt
 *   npm run sync:products -- --apply --update-existing   # skriv även om befintliga
 *   npm run sync:products -- --apply --include-drafts    # ta med ej publicerade
 *
 * Noteringar:
 *  - Varje VARIANT blir en egen Fortnox-artikel (så fungerar artikelregistret).
 *  - Varianter utan SKU hoppas över — de går inte att mappa vid fakturering.
 *  - Priset är informativt i Fortnox; fakturan använder alltid priset från
 *    Shopify-ordern.
 */

const APPLY = process.argv.includes("--apply");
const UPDATE_EXISTING = process.argv.includes("--update-existing");
const INCLUDE_DRAFTS = process.argv.includes("--include-drafts");

/** Fortnox artikelbeskrivning är kort — håll oss inom en säker längd. */
const DESC_MAX = 50;

function describe(productTitle: string, v: ShopifyVariant): string {
  const variantTitle = (v.title ?? "").trim();
  const generic = !variantTitle || /^default title$/i.test(variantTitle);
  const full = generic ? productTitle : `${productTitle} – ${variantTitle}`;
  return full.trim().slice(0, DESC_MAX);
}

async function main() {
  logger.info(
    APPLY
      ? `SKARP KÖRNING: speglar Shopify-produkter till Fortnox-artiklar${UPDATE_EXISTING ? " (skriver även om befintliga)" : ""}`
      : "DRY-RUN — inget skrivs till Fortnox. Kör med --apply."
  );

  const products = await listAllProducts();
  const active = products.filter((p) => INCLUDE_DRAFTS || p.status === "ACTIVE");
  logger.info(
    `${products.length} produkter i Shopify (${active.length} tas med${INCLUDE_DRAFTS ? "" : ", endast ACTIVE"}).`
  );

  let created = 0;
  let updated = 0;
  let exists = 0;
  let noSku = 0;
  let failed = 0;
  const failures: string[] = [];

  for (const p of active) {
    for (const v of p.variants.nodes) {
      const sku = (v.sku ?? "").trim();
      if (!sku) {
        noSku++;
        logger.debug(`~ hoppar variant utan SKU: ${p.title} / ${v.title ?? ""}`);
        continue;
      }
      const description = describe(p.title, v);
      const label = `${sku} (${description})`;

      try {
        const existing = await getArticle(sku);

        if (existing && !UPDATE_EXISTING) {
          exists++;
          // Håll den lokala cachen aktuell även när vi inte rör Fortnox.
          if (APPLY) {
            await prisma.articleMapping.upsert({
              where: { sku },
              create: { sku, articleNumber: sku, description },
              update: { articleNumber: sku, description, lastSyncedAt: new Date() },
            });
          }
          logger.debug(`= finns redan: ${label}`);
          continue;
        }

        if (!APPLY) {
          logger.info(existing ? `~ skulle uppdatera: ${label}` : `+ skulle skapa: ${label}`);
          continue;
        }

        if (existing) {
          await updateArticle(sku, { ArticleNumber: sku, Description: description });
          updated++;
          logger.info(`~ uppdaterade: ${label}`);
        } else {
          await createArticle({
            ArticleNumber: sku,
            Description: description,
            Active: true,
          });
          created++;
          logger.info(`+ skapade: ${label}`);
        }

        await prisma.articleMapping.upsert({
          where: { sku },
          create: { sku, articleNumber: sku, description },
          update: { articleNumber: sku, description, lastSyncedAt: new Date() },
        });
      } catch (err) {
        failed++;
        const msg = `${label}: ${(err as Error).message}`;
        failures.push(msg);
        logger.error(`✗ misslyckades: ${msg}`);
      }
    }
  }

  if (APPLY) {
    await audit({
      shopDomain: env.SHOPIFY_SHOP_DOMAIN,
      flow: "C",
      entityType: "article_sync",
      step: "products.push",
      status: failed > 0 ? "error" : "ok",
      message: `skapade ${created}, uppdaterade ${updated}, fanns ${exists}, fel ${failed}`,
    });
  }

  logger.info("──────── SAMMANFATTNING ────────");
  logger.info(`Varianter utan SKU:  ${noSku}`);
  logger.info(`Fanns redan:         ${exists}`);
  if (APPLY) {
    logger.info(`Skapade:             ${created}`);
    logger.info(`Uppdaterade:         ${updated}`);
    logger.info(`Misslyckade:         ${failed}`);
    for (const f of failures) logger.error(`  ✗ ${f}`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  logger.error({ err }, "syncProductsToFortnox kraschade");
  process.exit(1);
});
