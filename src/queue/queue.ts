import { Queue } from "bullmq";
import { bullConnection } from "../lib/redis";

export const QUEUE_NAME = "fortnox-sync";

export interface CustomerCompanyJob {
  shopDomain: string;
  companyGid: string;
}
export interface CustomerLocationJob {
  shopDomain: string;
  locationGid: string;
}
export interface OrderFulfilledJob {
  shopDomain: string;
  orderGid: string;
  orderName?: string;
  fulfillmentId?: string;
}

export type JobName =
  | "customer.company"
  | "customer.location"
  | "order.fulfilled"
  | "invoice.consolidate";

let queue: Queue | null = null;
export function getQueue(): Queue {
  if (!queue) {
    queue = new Queue(QUEUE_NAME, {
      connection: bullConnection(),
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: { count: 1000 },
        removeOnFail: false, // behåll misslyckade för inspektion (dead-letter)
      },
    });
  }
  return queue;
}

/**
 * Jobb-id:t måste vara unikt PER HÄNDELSE, inte per entitet: BullMQ vägrar lägga
 * till ett jobb vars id redan finns (även bland färdiga jobb), så ett id som
 * `company:<gid>` skulle få alla framtida uppdateringar av samma bolag att tyst
 * försvinna. Shopifys retries dedupliceras redan på X-Shopify-Webhook-Id i
 * webhook-mottagaren (ProcessedWebhook), så vi använder det id:t här.
 */
/** BullMQ förbjuder ":" i jobb-id (Shopify-GID:er är fulla av dem). */
const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "-");

const jobOpts = (kind: string, key: string, eventId?: string) => ({
  jobId: eventId
    ? `${kind}-${clean(eventId)}`
    : `${kind}-${clean(key)}-${Date.now()}`,
});

export function enqueueCompany(data: CustomerCompanyJob, eventId?: string) {
  return getQueue().add("customer.company", data, jobOpts("company", data.companyGid, eventId));
}

export function enqueueCompanyLocation(data: CustomerLocationJob, eventId?: string) {
  return getQueue().add(
    "customer.location",
    data,
    jobOpts("location", data.locationGid, eventId)
  );
}

export function enqueueOrderFulfilled(data: OrderFulfilledJob, eventId?: string) {
  return getQueue().add(
    "order.fulfilled",
    data,
    jobOpts("order", `${data.orderGid}:${data.fulfillmentId ?? ""}`, eventId)
  );
}

/**
 * Schemalägger den dagliga samlingsfaktureringen (BullMQ repeatable).
 * Körs varje dag kl. CONSOLIDATION_HOUR; jobbet avgör själv vilka kunder som
 * har en period att klippa i dag.
 */
export async function scheduleConsolidation(hour: number) {
  const queue = getQueue();
  // Rensa bort ev. gammalt schema så en ändrad timme slår igenom.
  for (const r of await queue.getRepeatableJobs()) {
    if (r.name === "invoice.consolidate") {
      await queue.removeRepeatableByKey(r.key);
    }
  }
  await queue.add(
    "invoice.consolidate",
    {},
    {
      repeat: { pattern: `0 ${hour} * * *`, tz: "Europe/Stockholm" },
      jobId: "consolidation-daily",
      removeOnComplete: { count: 50 },
    }
  );
}
