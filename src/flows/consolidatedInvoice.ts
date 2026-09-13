import { env } from "../config/env";
import { logger } from "../lib/logger";
import { prisma } from "../lib/prisma";
import { getOrder } from "../shopify/data";
import {
  bookkeepInvoice,
  createInvoiceFromOrder,
  createOrder,
  emailInvoice,
  eprintInvoice,
} from "../fortnox/client";
import type { FortnoxOrderRow } from "../fortnox/types";
import { getStorefrontConfig } from "../config/storefronts";
import { patchOrderMapping } from "../domain/mapping";
import { audit } from "../domain/audit";
import { alert } from "../notify/notifier";
import { buildOrderRows } from "./orderInvoice";
import { isCutDay } from "../domain/billing";

/**
 * Samlingsfakturering: slår ihop en kunds parkerade ordrar till EN Fortnox-order
 * → EN faktura. Varje rad märks med sitt Shopify-ordernummer så kunden kan
 * stämma av. Minskar antalet fakturor att handlägga drastiskt.
 *
 * Ordrar parkeras av Flöde B (state AWAITING_CONSOLIDATION) när kundens
 * invoiceMode är weekly/biweekly/monthly.
 */

export interface ConsolidationResult {
  groups: number;
  invoiced: number;
  ordersInvoiced: number;
  skipped: number;
  failed: number;
}

export interface ConsolidationOptions {
  apply: boolean;
  /** Ignorera periodschemat och fakturera allt parkerat nu. */
  force?: boolean;
  /** Begränsa till en specifik CompanyLocation. */
  locationId?: string;
  shopDomain?: string;
}

export async function runConsolidation(
  opts: ConsolidationOptions
): Promise<ConsolidationResult> {
  const shopDomain = opts.shopDomain ?? env.SHOPIFY_SHOP_DOMAIN;
  const result: ConsolidationResult = {
    groups: 0,
    invoiced: 0,
    ordersInvoiced: 0,
    skipped: 0,
    failed: 0,
  };

  const pending = await prisma.orderMapping.findMany({
    where: {
      shopDomain,
      state: "AWAITING_CONSOLIDATION",
      ...(opts.locationId ? { companyLocationId: opts.locationId } : {}),
    },
    orderBy: { createdAt: "asc" },
  });
  if (pending.length === 0) {
    logger.info("Inga parkerade ordrar att samlingsfakturera.");
    return result;
  }

  // Gruppera per kund + valuta (olika valutor kan inte ligga på samma faktura).
  const groups = new Map<string, typeof pending>();
  for (const row of pending) {
    if (!row.companyLocationId || !row.fortnoxCustomerNumber) {
      logger.warn({ order: row.shopifyOrderId }, "Parkerad order saknar kundkoppling — hoppar");
      result.skipped++;
      continue;
    }
    const key = `${row.companyLocationId}|${row.currency ?? "SEK"}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  result.groups = groups.size;

  for (const [key, rows] of groups) {
    const [locationId, currency] = key.split("|");
    const custNr = rows[0]!.fortnoxCustomerNumber!;
    const mapping = await prisma.customerMapping.findUnique({
      where: { shopDomain_companyLocationId: { shopDomain, companyLocationId: locationId! } },
    });
    const mode = mapping?.invoiceMode ?? "per_order";

    if (!opts.force && !isCutDay(mode)) {
      logger.debug(
        `= ${custNr}: ${rows.length} parkerade ordrar, men inte klippdag för "${mode}"`
      );
      result.skipped++;
      continue;
    }

    logger.info(
      `${opts.apply ? "Fakturerar" : "Skulle fakturera"} kund ${custNr} (${mode}): ${rows.length} ordrar, ${currency}`
    );

    try {
      // Hämta alla ordrar och bygg en gemensam radlista.
      const allRows: FortnoxOrderRow[] = [];
      const missingAll: string[] = [];
      const orderNames: string[] = [];
      let freightTotal = 0;
      let taxesIncluded: boolean | null = null;
      let mismatch = false;

      for (const row of rows) {
        const o = await getOrder(row.shopifyOrderId);
        if (!o) {
          logger.warn({ order: row.shopifyOrderId }, "Order finns inte i Shopify — hoppar");
          continue;
        }
        if (taxesIncluded === null) taxesIncluded = o.taxesIncluded;
        else if (taxesIncluded !== o.taxesIncluded) mismatch = true;

        const built = await buildOrderRows(o, shopDomain, o.name);
        missingAll.push(...built.missing);
        allRows.push(...built.rows);
        if (built.freight) freightTotal += built.freight;
        orderNames.push(o.name);
      }

      if (mismatch) {
        await alert(
          "Samlingsfaktura blockerad: olika momsinställning",
          `Kund ${custNr} har parkerade ordrar med olika taxesIncluded (${orderNames.join(", ")}). ` +
            `De kan inte ligga på samma faktura. Reda ut prisinställningarna och kör om.`
        );
        result.skipped++;
        continue;
      }
      if (missingAll.length > 0) {
        await alert(
          "Samlingsfaktura blockerad: okänd artikel",
          `Kund ${custNr}: SKU saknas i Fortnox — ${[...new Set(missingAll)].join(", ")}. ` +
            `Ordrar: ${orderNames.join(", ")}. Kör npm run sync:products och försök igen.`
        );
        result.skipped++;
        continue;
      }
      if (allRows.length === 0) {
        logger.warn(`Kund ${custNr}: inga rader att fakturera — hoppar`);
        result.skipped++;
        continue;
      }

      if (!opts.apply) {
        logger.info(
          `  → ${allRows.length} rader från ${orderNames.join(", ")} (dry-run, inget skapas)`
        );
        continue;
      }

      const config = await getStorefrontConfig(shopDomain);
      const created = await createOrder({
        CustomerNumber: custNr,
        OrderRows: allRows,
        Currency: currency,
        VATIncluded: taxesIncluded ?? config.pricesIncludeVat,
        ExternalInvoiceReference1: `Samlingsfaktura ${orderNames.join(" ")}`.slice(0, 80),
        ...(freightTotal > 0 ? { Freight: freightTotal } : {}),
      });
      const orderNr = created.DocumentNumber!;

      const inv = await createInvoiceFromOrder(orderNr);
      const invNr = inv.DocumentNumber!;

      if (config.sendMethod === "eprint") await eprintInvoice(invNr);
      else await emailInvoice(invNr);

      if (config.autoBookkeep) await bookkeepInvoice(invNr);

      for (const row of rows) {
        await patchOrderMapping(row.id, {
          state: "BOOKKEPT",
          fortnoxOrderNumber: orderNr,
          fortnoxInvoiceNumber: invNr,
          lastError: null,
        });
      }
      if (mapping) {
        await prisma.customerMapping.update({
          where: { id: mapping.id },
          data: { lastConsolidatedAt: new Date() },
        });
      }

      await audit({
        shopDomain,
        flow: "B",
        entityType: "consolidated_invoice",
        entityId: invNr,
        step: "consolidation.invoiced",
        status: "ok",
        message: `Kund ${custNr}: faktura ${invNr} för ${rows.length} ordrar (${orderNames.join(", ")})`,
      });
      logger.info(`✓ faktura ${invNr} för kund ${custNr} (${rows.length} ordrar)`);
      result.invoiced++;
      result.ordersInvoiced += rows.length;
    } catch (err) {
      result.failed++;
      logger.error({ err, custNr }, "Samlingsfakturering misslyckades");
      await audit({
        shopDomain,
        flow: "B",
        entityType: "consolidated_invoice",
        entityId: custNr,
        step: "consolidation.invoiced",
        status: "error",
        message: (err as Error).message,
      });
      await alert(
        "Samlingsfakturering misslyckades",
        `Kund ${custNr}: ${(err as Error).message}\nOrdrarna ligger kvar parkerade och försöks igen.`
      );
    }
  }

  return result;
}
