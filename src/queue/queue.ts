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

export type JobName = "customer.company" | "customer.location" | "order.fulfilled";

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

export function enqueueCompany(data: CustomerCompanyJob) {
  return getQueue().add("customer.company", data, {
    jobId: `company:${data.companyGid}`,
  });
}

export function enqueueCompanyLocation(data: CustomerLocationJob) {
  return getQueue().add("customer.location", data, {
    jobId: `location:${data.locationGid}`,
  });
}

export function enqueueOrderFulfilled(data: OrderFulfilledJob) {
  return getQueue().add("order.fulfilled", data, {
    jobId: `order:${data.orderGid}:${data.fulfillmentId ?? ""}`,
  });
}
