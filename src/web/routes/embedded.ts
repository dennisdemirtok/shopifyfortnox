import { Router, urlencoded } from "express";
import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { isValidMode } from "../../domain/billing";
import { audit } from "../../domain/audit";
import { runConsolidation } from "../../flows/consolidatedInvoice";
import { setCompanyInvoiceMode } from "../../shopify/data";
import {
  issueFormToken,
  verifyEmbeddedRequest,
  verifyFormToken,
} from "../../shopify/embedAuth";
import { renderBillingView, type BillingRow } from "../views/billing";

/**
 * Inbäddad adminvy i Shopify: butikens personal hittar den under Apps →
 * IAE Fortnox Sync. Åtkomsten styrs av Shopifys personalkonton — ingen delad
 * hemlig länk behövs.
 */
export const embeddedRouter = Router();

/** Shopify laddar oss i en iframe — tillåt just de ramarna, inga andra. */
embeddedRouter.use("/app", (_req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    `frame-ancestors https://${env.SHOPIFY_SHOP_DOMAIN} https://admin.shopify.com`
  );
  next();
});

async function loadBillingData() {
  const rows = (await prisma.customerMapping.findMany({
    where: { shopDomain: env.SHOPIFY_SHOP_DOMAIN },
    orderBy: { fortnoxCustomerNumber: "asc" },
  })) as BillingRow[];
  const pending = await prisma.orderMapping.groupBy({
    by: ["companyLocationId"],
    where: { shopDomain: env.SHOPIFY_SHOP_DOMAIN, state: "AWAITING_CONSOLIDATION" },
    _count: { _all: true },
  });
  const pendingBy = new Map(pending.map((p) => [p.companyLocationId ?? "", p._count._all]));
  return { rows, pendingBy };
}

function renderDenied(res: import("express").Response) {
  return res
    .status(401)
    .type("html")
    .send(
      `<p style="font:15px system-ui;padding:24px">Kunde inte verifiera att sidan öppnades från Shopify-admin. Öppna appen via <strong>Apps → IAE Fortnox Sync</strong>.</p>`
    );
}

embeddedRouter.get("/app", async (req, res) => {
  const query = Object.fromEntries(
    Object.entries(req.query).map(([k, v]) => [k, String(v)])
  ) as Record<string, string>;

  // Antingen en färsk laddning från Shopify, eller en redirect tillbaka hit
  // efter en formulärpost (då har vi bara vår egen kortlivade token).
  const session = verifyEmbeddedRequest(query) ?? verifyFormToken(query.t);
  if (!session) return renderDenied(res);

  const { rows, pendingBy } = await loadBillingData();
  res.type("html").send(
    renderBillingView({
      rows,
      pendingBy,
      hidden: { t: query.t ?? issueFormToken(session.shop) },
      actionSet: "/app/mode",
      actionRun: "/app/run",
      msg: typeof req.query.msg === "string" ? req.query.msg : undefined,
      embedded: true,
      apiKey: env.SHOPIFY_API_KEY,
    })
  );
});

embeddedRouter.post(
  "/app/mode",
  urlencoded({ extended: false, limit: "16kb" }),
  async (req, res) => {
    const body = req.body as Record<string, string>;
    if (!verifyFormToken(body.t)) return renderDenied(res);
    const { mappingId, mode } = body;
    if (!mappingId || !isValidMode(mode)) {
      return res.redirect(303, `/app?t=${encodeURIComponent(body.t!)}&msg=Ogiltigt+val`);
    }
    const updated = await prisma.customerMapping.update({
      where: { id: mappingId },
      data: { invoiceMode: mode },
    });
    try {
      await setCompanyInvoiceMode(updated.companyId, mode);
    } catch (err) {
      logger.error({ err }, "Kunde inte skriva faktureringsrytm till Shopify");
    }
    await audit({
      shopDomain: env.SHOPIFY_SHOP_DOMAIN,
      flow: "system",
      entityType: "billing_config",
      entityId: updated.fortnoxCustomerNumber,
      step: "invoiceMode.changed",
      status: "ok",
      message: `Kund ${updated.fortnoxCustomerNumber}: ${mode}`,
    });
    res.redirect(303, `/app?t=${encodeURIComponent(body.t!)}&msg=Sparat`);
  }
);

embeddedRouter.post(
  "/app/run",
  urlencoded({ extended: false, limit: "16kb" }),
  async (req, res) => {
    const body = req.body as Record<string, string>;
    if (!verifyFormToken(body.t)) return renderDenied(res);
    const result = await runConsolidation({
      apply: true,
      force: true,
      ...(body.locationId ? { locationId: body.locationId } : {}),
    });
    res.redirect(
      303,
      `/app?t=${encodeURIComponent(body.t!)}&msg=${encodeURIComponent(
        `Fakturerade ${result.ordersInvoiced} ordrar på ${result.invoiced} faktura(or)`
      )}`
    );
  }
);
