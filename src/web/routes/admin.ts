import { Router, urlencoded } from "express";
import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { runConsolidation } from "../../flows/consolidatedInvoice";
import { setCompanyInvoiceMode } from "../../shopify/data";
import { isValidMode } from "../../domain/billing";
import { renderBillingView, type BillingRow } from "../views/billing";
import { audit } from "../../domain/audit";

/**
 * Enkel adminvy för faktureringsrytm per kund:
 *   /admin/billing?token=...
 *
 * Skyddas av ADMIN_TOKEN. Är den inte satt är sidan helt avstängd (404) — vi
 * exponerar hellre ingenting än en oskyddad vy över kunddata.
 */
export const adminRouter = Router();

function authed(token: unknown): boolean {
  if (!env.ADMIN_TOKEN) return false;
  return typeof token === "string" && token === env.ADMIN_TOKEN;
}

adminRouter.use("/admin", (req, res, next) => {
  if (!env.ADMIN_TOKEN) return res.status(404).send("not found");
  const token = req.query.token ?? (req.body as Record<string, unknown> | undefined)?.token;
  if (!authed(token)) {
    res.setHeader("WWW-Authenticate", "Token");
    return res.status(401).type("html").send(
      `<p style="font:15px system-ui;padding:24px">Åtkomst kräver token: lägg till <code>?token=…</code> i adressen.</p>`
    );
  }
  next();
});

adminRouter.get("/admin/billing", async (req, res) => {
  const token = String(req.query.token ?? "");
  const rows = (await prisma.customerMapping.findMany({
    where: { shopDomain: env.SHOPIFY_SHOP_DOMAIN },
    orderBy: [{ companyName: "asc" }, { fortnoxCustomerNumber: "asc" }],
  })) as BillingRow[];
  const pending = await prisma.orderMapping.groupBy({
    by: ["companyLocationId"],
    where: { shopDomain: env.SHOPIFY_SHOP_DOMAIN, state: "AWAITING_CONSOLIDATION" },
    _count: { _all: true },
  });
  const pendingBy = new Map(
    pending.map((p) => [p.companyLocationId ?? "", p._count._all])
  );
  res.type("html").send(
    renderBillingView({
      rows,
      pendingBy,
      hidden: { token },
      actionSet: "/admin/billing",
      actionRun: "/admin/billing/run",
      msg: typeof req.query.msg === "string" ? req.query.msg : undefined,
    })
  );
});

adminRouter.post(
  "/admin/billing",
  urlencoded({ extended: false, limit: "16kb" }),
  async (req, res) => {
    const body = req.body as Record<string, string>;
    const token = body.token ?? "";
    const { mappingId, mode } = body;
    if (!mappingId || !isValidMode(mode)) {
      return res.redirect(303, `/admin/billing?token=${encodeURIComponent(token)}&msg=fel`);
    }
    const updated = await prisma.customerMapping.update({
      where: { id: mappingId },
      data: { invoiceMode: mode },
    });
    // Shopify är sanningen — skriv metafältet så att företagssidan i admin stämmer.
    try {
      await setCompanyInvoiceMode(updated.companyId, mode!);
    } catch (err) {
      logger.error(
        { err, company: updated.companyId },
        "Kunde inte skriva faktureringsrytm till Shopify (lokalt värde sparat)"
      );
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
    logger.info(
      { customer: updated.fortnoxCustomerNumber, mode },
      "Faktureringsrytm ändrad"
    );
    res.redirect(303, `/admin/billing?token=${encodeURIComponent(token)}&msg=sparat`);
  }
);

/** Kör samlingsfaktureringen direkt (t.ex. för att tömma en kund i förtid). */
adminRouter.post(
  "/admin/billing/run",
  urlencoded({ extended: false, limit: "16kb" }),
  async (req, res) => {
    const body = req.body as Record<string, string>;
    const token = body.token ?? "";
    const result = await runConsolidation({
      apply: true,
      force: true,
      ...(body.locationId ? { locationId: body.locationId } : {}),
    });
    res.redirect(
      303,
      `/admin/billing?token=${encodeURIComponent(token)}&msg=${encodeURIComponent(
        `Körde samlingsfakturering: ${result.invoiced} fakturor för ${result.ordersInvoiced} ordrar`
      )}`
    );
  }
);
