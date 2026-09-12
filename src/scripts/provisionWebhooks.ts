import { env } from "../config/env";
import {
  createWebhook,
  deleteWebhook,
  listWebhooks,
  WEBHOOK_TOPIC_ENUMS,
} from "../shopify/webhooks";
import { logger } from "../lib/logger";

/**
 * Registrerar webhook-prenumerationer mot ${APP_BASE_URL}/webhooks/shopify.
 * Alla topics pekar på samma URL; routing sker via X-Shopify-Topic-headern.
 * Idempotent: hoppar över topics som redan pekar rätt.
 */
async function main() {
  const uri = `${env.APP_BASE_URL}/webhooks/shopify`;
  logger.info(`Provisionerar webhooks → ${uri}`);

  const existing = await listWebhooks();

  // Städa bort prenumerationer på våra topics som pekar på en gammal URL
  // (t.ex. en död tunnel efter flytt till ny domän).
  for (const w of existing) {
    if ((WEBHOOK_TOPIC_ENUMS as readonly string[]).includes(w.topic) && w.uri !== uri) {
      const del = await deleteWebhook(w.id);
      if (del.userErrors?.length) {
        logger.error({ errors: del.userErrors }, `✗ kunde inte ta bort ${w.topic} (${w.uri})`);
      } else {
        logger.info(`- tog bort inaktuell ${w.topic} → ${w.uri}`);
      }
    }
  }

  for (const topic of WEBHOOK_TOPIC_ENUMS) {
    const already = existing.find((w) => w.topic === topic && w.uri === uri);
    if (already) {
      logger.info(`= ${topic} finns redan (${already.id})`);
      continue;
    }
    const result = await createWebhook(topic, uri);
    if (result.userErrors && result.userErrors.length > 0) {
      logger.error({ topic, errors: result.userErrors }, `✗ ${topic} misslyckades`);
    } else {
      logger.info(`+ ${topic} → ${result.webhookSubscription?.id}`);
    }
  }
  logger.info("Klart.");
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, "provisionWebhooks misslyckades");
  process.exit(1);
});
