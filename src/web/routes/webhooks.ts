import { Router, raw } from "express";
import { verifyShopifyHmac } from "../../shopify/hmac";
import { ensureGid } from "../../shopify/data";
import { isWebhookProcessed, markWebhookProcessed } from "../../domain/mapping";
import {
  enqueueCompany,
  enqueueCompanyLocation,
  enqueueOrderFulfilled,
} from "../../queue/queue";
import { audit } from "../../domain/audit";
import { logger } from "../../lib/logger";
import { env } from "../../config/env";

export const webhookRouter = Router();

interface ShopifyWebhookPayload {
  id?: number | string;
  admin_graphql_api_id?: string;
  name?: string;
}

/**
 * Shopify webhook-mottagare. RÅ body krävs för HMAC.
 * Verifierar → dedup → lägger i kö → 200. Inga Fortnox-anrop synkront (spec §3).
 */
webhookRouter.post(
  "/shopify",
  raw({ type: () => true }),
  async (req, res) => {
    const rawBody = req.body as Buffer;
    const hmac = req.header("X-Shopify-Hmac-Sha256");

    if (!Buffer.isBuffer(rawBody) || !verifyShopifyHmac(rawBody, hmac)) {
      logger.warn("Webhook med ogiltig HMAC avvisad");
      return res.status(401).send("invalid hmac");
    }

    const topic = req.header("X-Shopify-Topic") ?? "";
    const webhookId = req.header("X-Shopify-Webhook-Id") ?? "";
    const shopDomain = req.header("X-Shopify-Shop-Domain") ?? env.SHOPIFY_SHOP_DOMAIN;

    try {
      if (webhookId && (await isWebhookProcessed(webhookId))) {
        return res.status(200).send("duplicate");
      }

      const payload = JSON.parse(rawBody.toString("utf8")) as ShopifyWebhookPayload;

      switch (topic) {
        case "companies/create":
        case "companies/update": {
          const companyGid = payload.admin_graphql_api_id ?? ensureGid("Company", payload.id!);
          await enqueueCompany({ shopDomain, companyGid }, webhookId);
          break;
        }
        case "company_locations/create":
        case "company_locations/update": {
          const locationGid =
            payload.admin_graphql_api_id ?? ensureGid("CompanyLocation", payload.id!);
          await enqueueCompanyLocation({ shopDomain, locationGid }, webhookId);
          break;
        }
        case "orders/fulfilled": {
          const orderGid = payload.admin_graphql_api_id ?? ensureGid("Order", payload.id!);
          await enqueueOrderFulfilled(
            { shopDomain, orderGid, orderName: payload.name },
            webhookId
          );
          break;
        }
        default:
          logger.info({ topic }, "Webhook-topic ignoreras (ingen handler)");
          await audit({
            shopDomain,
            flow: "system",
            entityType: "webhook",
            entityId: webhookId,
            step: "received.ignored",
            status: "skipped",
            message: topic,
          });
          if (webhookId) await markWebhookProcessed(webhookId, topic, shopDomain);
          return res.status(200).send("ignored");
      }

      if (webhookId) await markWebhookProcessed(webhookId, topic, shopDomain);
      await audit({
        shopDomain,
        flow: topic.startsWith("orders") ? "B" : "A",
        entityType: "webhook",
        entityId: webhookId,
        step: "received.enqueued",
        status: "ok",
        message: topic,
      });
      return res.status(200).send("ok");
    } catch (err) {
      // Returnera 500 så Shopify försöker igen (vi hann inte köa).
      logger.error({ err, topic }, "Fel vid hantering av webhook — Shopify retryar");
      return res.status(500).send("error");
    }
  }
);
