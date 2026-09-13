import { logger } from "../lib/logger";
import { listArticles, listTermsOfPayments } from "../fortnox/client";

/**
 * Läser ut uppgifter ur Fortnox som behövs för konfigurationen:
 * fraktartikelns artikelnummer och vilka betalningsvillkor som finns upplagda.
 *
 *   npm run fortnox:inspect
 */
async function main() {
  logger.info("── Betalningsvillkor i Fortnox ──");
  try {
    const terms = await listTermsOfPayments();
    if (terms.length === 0) logger.info("(inga upplagda)");
    for (const t of terms) logger.info(`  ${t.Code}  —  ${t.Description ?? ""}`);
  } catch (err) {
    // Kräver "settings"-scope som vi medvetet inte begär — villkoren ligger ändå
    // kvar på kunden i Fortnox och rörs inte av integrationen.
    logger.warn(`(kunde inte läsas: ${(err as Error).message.slice(0, 80)})`);
  }

  logger.info("── Artiklar som ser ut som frakt ──");
  let page = 1;
  let found = 0;
  let total = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await listArticles(page, 500);
    const arts = res.Articles ?? [];
    total += arts.length;
    for (const a of arts) {
      const hay = `${a.ArticleNumber ?? ""} ${a.Description ?? ""}`.toLowerCase();
      if (hay.includes("frakt") || hay.includes("ship")) {
        found++;
        logger.info(`  ${a.ArticleNumber}  —  ${a.Description ?? ""}`);
      }
    }
    const pages = res.MetaInformation?.["@TotalPages"] ?? 1;
    if (page >= pages || arts.length === 0) break;
    page++;
  }
  if (found === 0) logger.info("(hittade ingen fraktartikel)");
  logger.info(`Totalt ${total} artiklar i Fortnox.`);
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, "inspectFortnox misslyckades");
  process.exit(1);
});
