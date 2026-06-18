import { prisma } from "../lib/prisma";
import type { OrderState } from "./stateMachine";

// ── Kundmapping (Flöde A) ──────────────────────────────────────────────────
export function findCustomerMappingByLocation(
  shopDomain: string,
  companyLocationId: string
) {
  return prisma.customerMapping.findUnique({
    where: { shopDomain_companyLocationId: { shopDomain, companyLocationId } },
  });
}

export async function upsertCustomerMapping(params: {
  shopDomain: string;
  companyId: string;
  companyLocationId: string;
  organisationNumber?: string | null;
  fortnoxCustomerNumber: string;
}) {
  return prisma.customerMapping.upsert({
    where: {
      shopDomain_companyLocationId: {
        shopDomain: params.shopDomain,
        companyLocationId: params.companyLocationId,
      },
    },
    create: {
      shopDomain: params.shopDomain,
      companyId: params.companyId,
      companyLocationId: params.companyLocationId,
      organisationNumber: params.organisationNumber ?? null,
      fortnoxCustomerNumber: params.fortnoxCustomerNumber,
    },
    update: {
      companyId: params.companyId,
      organisationNumber: params.organisationNumber ?? null,
      fortnoxCustomerNumber: params.fortnoxCustomerNumber,
      lastSyncedAt: new Date(),
    },
  });
}

// ── Ordermapping (Flöde B) ─────────────────────────────────────────────────
export function findOrderMapping(
  shopDomain: string,
  shopifyOrderId: string,
  fulfillmentId = ""
) {
  return prisma.orderMapping.findUnique({
    where: {
      shopDomain_shopifyOrderId_fulfillmentId: {
        shopDomain,
        shopifyOrderId,
        fulfillmentId,
      },
    },
  });
}

export async function ensureOrderMapping(params: {
  shopDomain: string;
  shopifyOrderId: string;
  fulfillmentId?: string;
  orderName?: string;
}) {
  const fulfillmentId = params.fulfillmentId ?? "";
  const existing = await findOrderMapping(
    params.shopDomain,
    params.shopifyOrderId,
    fulfillmentId
  );
  if (existing) return existing;
  return prisma.orderMapping.create({
    data: {
      shopDomain: params.shopDomain,
      shopifyOrderId: params.shopifyOrderId,
      fulfillmentId,
      orderName: params.orderName ?? null,
      state: "PENDING",
    },
  });
}

export async function patchOrderMapping(
  id: string,
  patch: {
    state?: OrderState;
    fortnoxOrderNumber?: string;
    fortnoxInvoiceNumber?: string;
    lastError?: string | null;
    incrementAttempts?: boolean;
  }
) {
  return prisma.orderMapping.update({
    where: { id },
    data: {
      ...(patch.state ? { state: patch.state } : {}),
      ...(patch.fortnoxOrderNumber ? { fortnoxOrderNumber: patch.fortnoxOrderNumber } : {}),
      ...(patch.fortnoxInvoiceNumber
        ? { fortnoxInvoiceNumber: patch.fortnoxInvoiceNumber }
        : {}),
      ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
      ...(patch.incrementAttempts ? { attempts: { increment: 1 } } : {}),
    },
  });
}

// ── Webhook-idempotens ─────────────────────────────────────────────────────
export async function isWebhookProcessed(webhookId: string): Promise<boolean> {
  const row = await prisma.processedWebhook.findUnique({ where: { webhookId } });
  return !!row;
}

export async function markWebhookProcessed(
  webhookId: string,
  topic: string,
  shopDomain?: string
): Promise<void> {
  await prisma.processedWebhook.upsert({
    where: { webhookId },
    create: { webhookId, topic, shopDomain: shopDomain ?? null },
    update: {},
  });
}
