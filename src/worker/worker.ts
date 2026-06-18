import { Worker, type Job } from "bullmq";
import { bullConnection } from "../lib/redis";
import { QUEUE_NAME } from "../queue/queue";
import { syncCompany, syncCompanyLocation } from "../flows/customerSync";
import { handleOrderFulfilled } from "../flows/orderInvoice";
import { audit } from "../domain/audit";
import { alert } from "../notify/notifier";
import { logger } from "../lib/logger";

async function process(job: Job): Promise<void> {
  const data = job.data as Record<string, string>;
  switch (job.name) {
    case "customer.company":
      return syncCompany(data.shopDomain!, data.companyGid!);
    case "customer.location":
      return syncCompanyLocation(data.shopDomain!, data.locationGid!);
    case "order.fulfilled":
      return handleOrderFulfilled({
        shopDomain: data.shopDomain!,
        orderGid: data.orderGid!,
        orderName: data.orderName,
        fulfillmentId: data.fulfillmentId,
      });
    default:
      throw new Error(`Okänt jobbnamn: ${job.name}`);
  }
}

export function startWorker(): Worker {
  // Concurrency > 1 är OK: den globala Fortnox-throttlen (25/5s) skyddar API:t.
  const worker = new Worker(QUEUE_NAME, process, {
    connection: bullConnection(),
    concurrency: 5,
  });

  worker.on("failed", async (job, err) => {
    logger.error(
      {
        jobId: job?.id,
        name: job?.name,
        attemptsMade: job?.attemptsMade,
        err: err.message,
      },
      "Jobb misslyckades"
    );
    const maxAttempts = job?.opts.attempts ?? 1;
    if (job && job.attemptsMade >= maxAttempts) {
      await alert(
        "Dead-letter: jobb misslyckades slutgiltigt",
        `Jobb ${job.name} (${job.id}) misslyckades efter ${job.attemptsMade} försök.\n` +
          `Data: ${JSON.stringify(job.data)}\nSenaste fel: ${err.message}`
      );
      await audit({
        flow: job.name.startsWith("order") ? "B" : "A",
        entityType: "job",
        entityId: String(job.id),
        step: "dead-letter",
        status: "error",
        message: err.message,
      });
    }
  });

  worker.on("completed", (job) =>
    logger.debug({ jobId: job.id, name: job.name }, "Jobb klart")
  );
  worker.on("error", (err) => logger.error({ err }, "Worker-fel"));

  logger.info("Worker startad (kö: %s)", QUEUE_NAME);
  return worker;
}
