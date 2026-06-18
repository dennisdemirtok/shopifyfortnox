import { env } from "../config/env";
import {
  createWebhook,
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
