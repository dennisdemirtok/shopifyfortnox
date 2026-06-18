import { listWebhooks } from "../shopify/webhooks";
import { logger } from "../lib/logger";

async function main() {
  const subs = await listWebhooks();
  if (subs.length === 0) {
    logger.info("Inga webhook-prenumerationer registrerade.");
  } else {
    for (const s of subs) logger.info(`${s.topic}  →  ${s.uri}  (${s.id})`);
  }
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, "listWebhooks misslyckades");
  process.exit(1);
});
