import { env } from "./config/env";
import { logger } from "./lib/logger";
import { startServer } from "./web/server";
import { startWorker } from "./worker/worker";
import { scheduleConsolidation } from "./queue/queue";
import { prisma } from "./lib/prisma";
import type { Server } from "node:http";
import type { Worker } from "bullmq";

async function main() {
  logger.info(`Startar IAE Shopify → Fortnox (ROLE=${env.ROLE}, env=${env.NODE_ENV})`);

  let server: Server | undefined;
  let worker: Worker | undefined;

  if (env.ROLE === "web" || env.ROLE === "all") server = startServer();
  if (env.ROLE === "worker" || env.ROLE === "all") {
    worker = startWorker();
    if (env.CONSOLIDATION_ENABLED) {
      await scheduleConsolidation(env.CONSOLIDATION_HOUR);
      logger.info(
        `Samlingsfakturering schemalagd kl. ${env.CONSOLIDATION_HOUR}:00 (klippdag: veckodag ${env.CONSOLIDATION_WEEKDAY})`
      );
    }
  }

  const shutdown = async (sig: string) => {
    logger.info(`Mottog ${sig} — stänger ner...`);
    try {
      server?.close();
      if (worker) await worker.close();
      await prisma.$disconnect();
    } catch (err) {
      logger.error({ err }, "Fel vid nedstängning");
    }
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.error({ err }, "Fatalt uppstartsfel");
  process.exit(1);
});
