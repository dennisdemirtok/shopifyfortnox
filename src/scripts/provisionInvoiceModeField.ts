import { env } from "../config/env";
import { logger } from "../lib/logger";
import { prisma } from "../lib/prisma";
import {
  createInvoiceModeDefinition,
  listCompanyInvoiceModes,
  setCompanyInvoiceMode,
} from "../shopify/data";
import { isValidMode } from "../domain/billing";

/**
 * Gör "Faktureringsrytm (Fortnox)" tillgänglig som fält på företagssidan i
 * Shopify-admin, och synkar värdena i båda riktningar:
 *
 *  1. Skapar metafältsdefinitionen (idempotent).
 *  2. Företag som saknar värde i Shopify får sitt värde från vår DB (eller
 *     "per_order"), så fältet är ifyllt från start.
 *  3. Företag som HAR ett värde i Shopify speglas ned till vår DB.
 *
 *   npm run provision:invoice-field
 */
async function main() {
  const shopDomain = env.SHOPIFY_SHOP_DOMAIN;

  const def = await createInvoiceModeDefinition();
  logger.info(`Metafältsdefinition: ${def.message}`);

  const companies = await listCompanyInvoiceModes();
  logger.info(`${companies.length} företag i Shopify.`);

  let pushed = 0;
  let pulled = 0;
  let skipped = 0;
  let named = 0;

  for (const c of companies) {
    if (!c.locationId) {
      skipped++;
      continue;
    }
    const mapping = await prisma.customerMapping.findUnique({
      where: {
        shopDomain_companyLocationId: { shopDomain, companyLocationId: c.locationId },
      },
    });

    // Passa på att fylla i företagsnamnet i mappningen (visas i översikten).
    if (mapping && c.name && mapping.companyName !== c.name) {
      await prisma.customerMapping.update({
        where: { id: mapping.id },
        data: { companyName: c.name },
      });
      named++;
    }

    if (isValidMode(c.mode)) {
      // Shopify har ett värde → spegla ner till DB.
      if (mapping && mapping.invoiceMode !== c.mode) {
        await prisma.customerMapping.update({
          where: { id: mapping.id },
          data: { invoiceMode: c.mode },
        });
        pulled++;
        logger.info(`↓ ${c.name}: ${c.mode} (från Shopify)`);
      }
      continue;
    }

    // Shopify saknar värde → fyll i från DB (eller default) så fältet syns ifyllt.
    const mode = mapping?.invoiceMode ?? "per_order";
    await setCompanyInvoiceMode(c.id, mode);
    pushed++;
    logger.info(`↑ ${c.name}: ${mode} (satt i Shopify)`);
  }

  logger.info("──────── SAMMANFATTNING ────────");
  logger.info(`Satta i Shopify:   ${pushed}`);
  logger.info(`Hämtade till DB:   ${pulled}`);
  logger.info(`Namn ifyllda:      ${named}`);
  logger.info(`Utan location:     ${skipped}`);
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, "provisionInvoiceModeField misslyckades");
  process.exit(1);
});
