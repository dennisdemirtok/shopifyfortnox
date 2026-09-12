import { logger } from "../lib/logger";
import { runConsolidation } from "../flows/consolidatedInvoice";

/**
 * Manuell körning av samlingsfaktureringen.
 *
 *   npm run invoice:consolidate                  # DRY-RUN, endast kunder vars period är mogen
 *   npm run invoice:consolidate -- --force       # DRY-RUN, alla parkerade oavsett klippdag
 *   npm run invoice:consolidate -- --apply --force   # fakturera allt parkerat NU
 *   npm run invoice:consolidate -- --apply --location gid://shopify/CompanyLocation/123
 */
const APPLY = process.argv.includes("--apply");
const FORCE = process.argv.includes("--force");
const locIdx = process.argv.indexOf("--location");
const LOCATION = locIdx !== -1 ? process.argv[locIdx + 1] : undefined;

async function main() {
  logger.info(
    APPLY
      ? `SKARP KÖRNING${FORCE ? " (--force: ignorerar periodschema)" : ""}`
      : "DRY-RUN — inga fakturor skapas. Kör med --apply."
  );
  const res = await runConsolidation({
    apply: APPLY,
    force: FORCE,
    ...(LOCATION ? { locationId: LOCATION } : {}),
  });
  logger.info("──────── SAMMANFATTNING ────────");
  logger.info(`Kundgrupper:        ${res.groups}`);
  logger.info(`Fakturor skapade:   ${res.invoiced}`);
  logger.info(`Ordrar fakturerade: ${res.ordersInvoiced}`);
  logger.info(`Överhoppade:        ${res.skipped}`);
  logger.info(`Misslyckade:        ${res.failed}`);
  process.exit(res.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  logger.error({ err }, "consolidateInvoices kraschade");
  process.exit(1);
});
