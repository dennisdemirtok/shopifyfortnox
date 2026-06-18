import { shopifyGraphQL } from "./graphql";
import { WEBHOOK_SUBSCRIPTION_CREATE, WEBHOOK_SUBSCRIPTIONS } from "./queries";

/** GraphQL-enum-topics vi prenumererar på (spec §4 + §5). */
export const WEBHOOK_TOPIC_ENUMS = [
  "COMPANIES_CREATE",
  "COMPANIES_UPDATE",
  "COMPANY_LOCATIONS_CREATE",
  "COMPANY_LOCATIONS_UPDATE",
  "ORDERS_FULFILLED",
] as const;

export type WebhookTopicEnum = (typeof WEBHOOK_TOPIC_ENUMS)[number];

/** Header-topic (X-Shopify-Topic) -> intern hantering. */
export const HEADER_TOPIC = {
  COMPANIES_CREATE: "companies/create",
  COMPANIES_UPDATE: "companies/update",
  COMPANY_LOCATIONS_CREATE: "company_locations/create",
  COMPANY_LOCATIONS_UPDATE: "company_locations/update",
  ORDERS_FULFILLED: "orders/fulfilled",
} as const;

interface WebhookCreateResult {
  webhookSubscriptionCreate: {
    webhookSubscription: { id: string; topic: string; format: string } | null;
    userErrors: Array<{ field: string[] | null; message: string }>;
  };
}

export async function createWebhook(topic: WebhookTopicEnum, uri: string) {
  const data = await shopifyGraphQL<WebhookCreateResult>(WEBHOOK_SUBSCRIPTION_CREATE, {
    topic,
    webhookSubscription: { uri, format: "JSON" },
  });
  return data.webhookSubscriptionCreate;
}

interface WebhookListResult {
  webhookSubscriptions: {
    nodes: Array<{
      id: string;
      topic: string;
      uri: string;
    }>;
  };
}

export async function listWebhooks() {
  const data = await shopifyGraphQL<WebhookListResult>(WEBHOOK_SUBSCRIPTIONS);
  return data.webhookSubscriptions.nodes;
}
