import { listArticles } from "../fortnox/client";
import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";

/**
 * Försynkar artikelregistret från Fortnox till lokal ArticleMapping (spec §5).
 * Antar SKU = Fortnox ArticleNumber. Om era Shopify-SKU skiljer sig från Fortnox
 * ArticleNumber: lägg in egna rader i ArticleMapping (sku ≠ articleNumber).
 */
async function main() {
  let page = 1;
  let total = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await listArticles(page, 500);
    const arts = res.Articles ?? [];
    for (const a of arts) {
      if (!a.ArticleNumber) continue;
      await prisma.articleMapping.upsert({
        where: { sku: a.ArticleNumber },
        create: {
          sku: a.ArticleNumber,
          articleNumber: a.ArticleNumber,
          description: a.Description ?? null,
        },
        update: {
          articleNumber: a.ArticleNumber,
          description: a.Description ?? null,
          lastSyncedAt: new Date(),
        },
      });
      total++;
    }
    const pages = res.MetaInformation?.["@TotalPages"] ?? 1;
    logger.info(`Sida ${page}/${pages} — ${arts.length} artiklar`);
    if (page >= pages || arts.length === 0) break;
    page++;
  }
  logger.info(`Klart: ${total} artiklar synkade till ArticleMapping.`);
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, "syncArticles misslyckades");
  process.exit(1);
});
