import { getOrder } from "../shopify/data";
import { isPurchasingCompany, type OrderNode } from "../shopify/types";
import {
  bookkeepInvoice,
  createInvoiceFromOrder,
  createOrder,
  emailInvoice,
  eprintInvoice,
  getArticle,
} from "../fortnox/client";
import type { FortnoxOrderRow } from "../fortnox/types";
import { isEuCountry } from "../vat/matrix";
import { INVOICE_MODES } from "../domain/billing";
import {
  ensureOrderMapping,
  findCustomerMappingByLocation,
  findOrderMapping,
  getInvoiceMode,
  patchOrderMapping,
} from "../domain/mapping";
import { isAtLeast } from "../domain/stateMachine";
import { getStorefrontConfig } from "../config/storefronts";
import { prisma } from "../lib/prisma";
import { audit } from "../domain/audit";
import { alert } from "../notify/notifier";

export interface OrderJob {
  shopDomain: string;
  orderGid: string;
  orderName?: string;
  fulfillmentId?: string;
}

/** Summerar momssats i procent från Shopify-radens taxLines. */
function lineVatPercent(
  taxLines: Array<{ rate?: number | null; ratePercentage?: number | null }>
): number {
  if (!taxLines || taxLines.length === 0) return 0;
  let pct = 0;
  for (const t of taxLines) {
    if (typeof t.ratePercentage === "number") pct += t.ratePercentage;
    else if (typeof t.rate === "number") pct += t.rate * 100;
  }
  return Math.round(pct * 100) / 100;
}

function deriveAccountKey(country: string | undefined, anyTax: boolean): string {
  const c = (country ?? "SE").toUpperCase();
  if (c === "SE") return "sales_se";
  if (isEuCountry(c)) return anyTax ? "sales_se" : "sales_eu_reverse";
  return "sales_export";
}

/** SKU → Fortnox ArticleNumber. Okänd SKU returnerar null (→ larm, ingen auto-skapa). */
async function resolveArticleNumber(sku: string): Promise<string | null> {
  const m = await prisma.articleMapping.findUnique({ where: { sku } });
  if (m) return m.articleNumber;
  const art = await getArticle(sku); // i Fortnox är ArticleNumber ofta = SKU
  return art?.ArticleNumber ?? null;
}

export async function buildOrderRows(
  o: OrderNode,
  shopDomain: string,
  /** Prefixas på varje radbeskrivning vid samlingsfaktura, t.ex. "#1042". */
  rowPrefix?: string
): Promise<{ rows: FortnoxOrderRow[]; missing: string[]; freight?: number }> {
  const config = await getStorefrontConfig(shopDomain);
  const country =
    o.shippingAddress?.countryCodeV2 ?? o.billingAddress?.countryCodeV2 ?? "SE";

  // Spec §5: Shopify taxesIncluded MÅSTE matcha Fortnox VATIncluded.
  if (o.taxesIncluded !== config.pricesIncludeVat) {
    await alert(
      "Moms inkl/exkl-avvikelse",
      `Order ${o.name}: Shopify taxesIncluded=${o.taxesIncluded} men StorefrontConfig.pricesIncludeVat=${config.pricesIncludeVat}. ` +
        `Fortnox VATIncluded sätts efter Shopify (sanning), men kontrollera konfigurationen.`
    );
  }

  const rows: FortnoxOrderRow[] = [];
  const missing: string[] = [];
  let anyTax = false;

  for (const li of o.lineItems.nodes) {
    if (!li.sku) {
      missing.push(`(rad utan SKU: ${li.title})`);
      continue;
    }
    const articleNumber = await resolveArticleNumber(li.sku);
    if (!articleNumber) {
      missing.push(li.sku);
      continue;
    }
    const vatPct = lineVatPercent(li.taxLines);
    if (vatPct > 0) anyTax = true;
    const unitStr =
      li.discountedUnitPriceSet?.shopMoney.amount ??
      li.originalUnitPriceSet?.shopMoney.amount ??
      "0";
    rows.push({
      ArticleNumber: articleNumber,
      Description: rowPrefix ? `${rowPrefix} ${li.title}` : li.title,
      OrderedQuantity: li.quantity,
      DeliveredQuantity: li.quantity,
      Price: parseFloat(unitStr),
      VAT: vatPct,
    });
  }

  // Försäljningskonto per momsscenario (om konfigurerat).
  const accountKey = deriveAccountKey(country, anyTax);
  const acct = config.accountMap[accountKey];
  const acctNum = acct !== undefined ? Number(acct) : undefined;
  if (acctNum !== undefined) for (const r of rows) r.AccountNumber = acctNum;

  // Frakt som egen rad (spec §5) — annars Order.Freight som fallback.
  const shipping = parseFloat(o.totalShippingPriceSet?.shopMoney.amount ?? "0");
  let freight: number | undefined;
  if (shipping > 0) {
    const shipVat = o.shippingLines?.nodes?.[0]?.taxLines
      ? lineVatPercent(o.shippingLines.nodes[0].taxLines)
      : anyTax
        ? 25
        : 0;
    if (config.shippingArticleNr) {
      rows.push({
        ArticleNumber: config.shippingArticleNr,
        Description: rowPrefix ? `${rowPrefix} Frakt` : "Frakt",
        OrderedQuantity: 1,
        DeliveredQuantity: 1,
        Price: shipping,
        VAT: shipVat,
        ...(acctNum !== undefined ? { AccountNumber: acctNum } : {}),
      });
    } else {
      freight = shipping;
      await alert(
        "Fraktartikel saknas i konfig",
        `Order ${o.name}: frakt ${shipping} men shippingArticleNr saknas i StorefrontConfig. Använder Order.Freight som fallback.`
      );
    }
  }

  return { rows, missing, freight };
}

/**
 * Flöde B (spec §5/§8): orders/fulfilled → Fortnox order → faktura → utskick → bokför.
 * State machine: PENDING→ORDER_OK→INVOICE_OK→SENT→BOOKKEPT. Idempotent & återupptagbar.
 * Transienta fel kastas vidare → kö-retry; permanenta uttömmer retries → dead-letter.
 */
export async function handleOrderFulfilled(job: OrderJob): Promise<void> {
  const fulfillmentId = job.fulfillmentId ?? "";
  // Slå bara UPP mappningen här (skapa den inte): DTC-ordrar ska inte lämna
  // efter sig PENDING-rader som ser ut som fastnade B2B-ordrar.
  const existing = await findOrderMapping(
    job.shopDomain,
    job.orderGid,
    fulfillmentId
  );

  if (existing?.state === "BOOKKEPT") {
    await audit({
      shopDomain: job.shopDomain,
      flow: "B",
      entityType: "order",
      entityId: job.orderGid,
      step: "idempotent.skip",
      status: "skipped",
      message: `Redan klar (faktura ${existing.fortnoxInvoiceNumber})`,
    });
    return;
  }

  const o = await getOrder(job.orderGid);
  if (!o) {
    await audit({
      shopDomain: job.shopDomain,
      flow: "B",
      entityType: "order",
      entityId: job.orderGid,
      step: "fetch",
      status: "skipped",
      message: "Order hittades inte i Shopify",
    });
    return;
  }

  // Filtrera: agera bara på B2B-ordrar (Company). DTC ignoreras tidigt (spec §5).
  if (!isPurchasingCompany(o.purchasingEntity)) {
    await audit({
      shopDomain: job.shopDomain,
      flow: "B",
      entityType: "order",
      entityId: job.orderGid,
      step: "filter.b2b",
      status: "skipped",
      message: "Ej B2B-order (ingen Company) — ignoreras",
    });
    return;
  }

  // Först här vet vi att det är en B2B-order — skapa/återanvänd mappningen.
  let mapping =
    existing ??
    (await ensureOrderMapping({
      shopDomain: job.shopDomain,
      shopifyOrderId: job.orderGid,
      fulfillmentId,
      orderName: job.orderName,
    }));

  const pc = o.purchasingEntity;
  // Slå upp Fortnox-kund: externalId (Company/Location) eller lokal mapping.
  let custNr = pc.company.externalId || pc.location.externalId || undefined;
  if (!custNr) {
    const m = await findCustomerMappingByLocation(job.shopDomain, pc.location.id);
    custNr = m?.fortnoxCustomerNumber ?? undefined;
  }
  if (!custNr) {
    await patchOrderMapping(mapping.id, {
      state: "FAILED",
      lastError: "Fortnox-kund saknas (Flöde A ej körd?)",
    });
    await alert(
      "Order utan Fortnox-kund (Flöde B)",
      `Order ${o.name}: kunden (location ${pc.location.id}, ${pc.company.name}) finns inte i Fortnox. ` +
        `Flöde A ska ha skapat den. Auto-skapa görs EJ (spec §5/§8). Kör om kundsynk och därefter ordern.`
    );
    return;
  }

  // Samlingsfakturering: parkera ordern i stället för att fakturera direkt.
  // Ett schemalagt jobb slår ihop periodens ordrar till EN faktura.
  // Sanningen är metafältet på företaget i Shopify (custom.fortnox_invoice_mode);
  // vår DB används bara som reserv om fältet inte är satt.
  const fromShopify = pc.company.metafield?.value?.trim();
  const invoiceMode =
    fromShopify && INVOICE_MODES.includes(fromShopify as never)
      ? fromShopify
      : await getInvoiceMode(job.shopDomain, pc.location.id);
  if (invoiceMode !== "per_order" && !isAtLeast(mapping.state, "ORDER_OK")) {
    await patchOrderMapping(mapping.id, {
      state: "AWAITING_CONSOLIDATION",
      companyLocationId: pc.location.id,
      fortnoxCustomerNumber: custNr,
      currency: o.currencyCode,
      lastError: null,
    });
    await audit({
      shopDomain: job.shopDomain,
      flow: "B",
      entityType: "order",
      entityId: job.orderGid,
      step: "consolidation.parked",
      status: "ok",
      message: `${o.name} parkerad för samlingsfaktura (${invoiceMode}), kund ${custNr}`,
    });
    return;
  }

  try {
    if (!isAtLeast(mapping.state, "ORDER_OK")) {
      const { rows, missing, freight } = await buildOrderRows(o, job.shopDomain);
      if (missing.length > 0) {
        await patchOrderMapping(mapping.id, {
          state: "FAILED",
          lastError: `Okända SKU: ${missing.join(", ")}`,
        });
        await alert(
          "Okänd artikel vid order (Flöde B)",
          `Order ${o.name}: följande SKU saknas i Fortnox/artikelmapping: ${missing.join(", ")}. ` +
            `Kör artikel-försynk (npm run sync:articles). Ingen skräpartikel skapas (spec §5).`
        );
        return;
      }
      const created = await createOrder({
        CustomerNumber: custNr,
        OrderRows: rows,
        Currency: o.currencyCode,
        VATIncluded: o.taxesIncluded,
        ExternalInvoiceReference1: o.name,
        ...(freight !== undefined ? { Freight: freight } : {}),
      });
      mapping = await patchOrderMapping(mapping.id, {
        state: "ORDER_OK",
        fortnoxOrderNumber: created.DocumentNumber!,
        lastError: null,
      });
      await audit({
        shopDomain: job.shopDomain,
        flow: "B",
        entityType: "order",
        entityId: job.orderGid,
        step: "order.create",
        status: "ok",
        message: `Fortnox-order ${created.DocumentNumber}`,
      });
    }

    const orderDocNr = mapping.fortnoxOrderNumber!;

    if (!isAtLeast(mapping.state, "INVOICE_OK")) {
      const inv = await createInvoiceFromOrder(orderDocNr);
      mapping = await patchOrderMapping(mapping.id, {
        state: "INVOICE_OK",
        fortnoxInvoiceNumber: inv.DocumentNumber!,
      });
      await audit({
        shopDomain: job.shopDomain,
        flow: "B",
        entityType: "order",
        entityId: job.orderGid,
        step: "invoice.create",
        status: "ok",
        message: `Faktura ${inv.DocumentNumber}`,
      });
    }

    const invNr = mapping.fortnoxInvoiceNumber!;

    if (!isAtLeast(mapping.state, "SENT")) {
      const config = await getStorefrontConfig(job.shopDomain);
      if (config.sendMethod === "eprint") await eprintInvoice(invNr);
      else await emailInvoice(invNr);
      mapping = await patchOrderMapping(mapping.id, { state: "SENT" });
      await audit({
        shopDomain: job.shopDomain,
        flow: "B",
        entityType: "order",
        entityId: job.orderGid,
        step: "invoice.send",
        status: "ok",
        message: `Skickad via ${config.sendMethod}`,
      });
    }

    if (!isAtLeast(mapping.state, "BOOKKEPT")) {
      await bookkeepInvoice(invNr);
      mapping = await patchOrderMapping(mapping.id, { state: "BOOKKEPT" });
      await audit({
        shopDomain: job.shopDomain,
        flow: "B",
        entityType: "order",
        entityId: job.orderGid,
        step: "invoice.bookkeep",
        status: "ok",
        message: `Bokförd faktura ${invNr}`,
      });
    }
  } catch (err) {
    // Transient: spara fel, kasta vidare → kö-retry. Permanent: uttöms → dead-letter.
    await patchOrderMapping(mapping.id, {
      lastError: (err as Error).message,
      incrementAttempts: true,
    });
    throw err;
  }
}
