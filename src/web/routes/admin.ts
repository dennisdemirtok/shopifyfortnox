import { Router, urlencoded } from "express";
import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { INVOICE_MODES, runConsolidation } from "../../flows/consolidatedInvoice";
import { audit } from "../../domain/audit";

/**
 * Enkel adminvy för faktureringsrytm per kund:
 *   /admin/billing?token=...
 *
 * Skyddas av ADMIN_TOKEN. Är den inte satt är sidan helt avstängd (404) — vi
 * exponerar hellre ingenting än en oskyddad vy över kunddata.
 */
export const adminRouter = Router();

const MODE_LABEL: Record<string, string> = {
  per_order: "Per order (faktura direkt)",
  weekly: "Varje vecka",
  biweekly: "Varannan vecka",
  monthly: "Varje månad",
};

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
  const rows = await prisma.customerMapping.findMany({
    where: { shopDomain: env.SHOPIFY_SHOP_DOMAIN },
    orderBy: { fortnoxCustomerNumber: "asc" },
  });
  const pending = await prisma.orderMapping.groupBy({
    by: ["companyLocationId"],
    where: { shopDomain: env.SHOPIFY_SHOP_DOMAIN, state: "AWAITING_CONSOLIDATION" },
    _count: { _all: true },
  });
  const pendingBy = new Map(
    pending.map((p) => [p.companyLocationId ?? "", p._count._all])
  );
  res.type("html").send(renderBilling(rows, pendingBy, token, req.query.msg as string));
});

adminRouter.post(
  "/admin/billing",
  urlencoded({ extended: false, limit: "16kb" }),
  async (req, res) => {
    const body = req.body as Record<string, string>;
    const token = body.token ?? "";
    const { mappingId, mode } = body;
    if (!mappingId || !INVOICE_MODES.includes(mode as never)) {
      return res.redirect(303, `/admin/billing?token=${encodeURIComponent(token)}&msg=fel`);
    }
    const updated = await prisma.customerMapping.update({
      where: { id: mappingId },
      data: { invoiceMode: mode },
    });
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

const esc = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function renderBilling(
  rows: Array<{
    id: string;
    fortnoxCustomerNumber: string;
    companyLocationId: string;
    organisationNumber: string | null;
    invoiceMode: string;
    lastConsolidatedAt: Date | null;
  }>,
  pendingBy: Map<string, number>,
  token: string,
  msg?: string
): string {
  const body = rows
    .map((r) => {
      const pending = pendingBy.get(r.companyLocationId) ?? 0;
      const opts = INVOICE_MODES.map(
        (m) =>
          `<option value="${m}" ${m === r.invoiceMode ? "selected" : ""}>${MODE_LABEL[m]}</option>`
      ).join("");
      return `<tr>
        <td><strong>${esc(r.fortnoxCustomerNumber)}</strong><br><span class="dim">${esc(r.organisationNumber ?? "—")}</span></td>
        <td>
          <form method="post" action="/admin/billing" class="inline">
            <input type="hidden" name="token" value="${esc(token)}">
            <input type="hidden" name="mappingId" value="${esc(r.id)}">
            <select name="mode" onchange="this.form.submit()">${opts}</select>
          </form>
        </td>
        <td class="num">${pending > 0 ? `<span class="badge">${pending}</span>` : "<span class='dim'>0</span>"}</td>
        <td class="dim">${r.lastConsolidatedAt ? r.lastConsolidatedAt.toISOString().slice(0, 10) : "—"}</td>
        <td>${
          pending > 0
            ? `<form method="post" action="/admin/billing/run" class="inline">
                 <input type="hidden" name="token" value="${esc(token)}">
                 <input type="hidden" name="locationId" value="${esc(r.companyLocationId)}">
                 <button>Fakturera nu</button>
               </form>`
            : ""
        }</td>
      </tr>`;
    })
    .join("");

  return `<!doctype html><html lang="sv"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Faktureringsrytm</title>
<style>
 :root{--bg:#f6f6f7;--card:#fff;--ink:#1a1a1a;--dim:#6b7177;--line:#d9dbde;--accent:#1a1a1a}
 @media(prefers-color-scheme:dark){:root{--bg:#151719;--card:#1e2124;--ink:#f2f3f4;--dim:#a4abb2;--line:#343a3f;--accent:#f2f3f4}}
 body{margin:0;padding:28px 16px;background:var(--bg);color:var(--ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
 .wrap{max-width:900px;margin:0 auto}
 h1{font-size:22px;margin:0 0 4px} p.lead{color:var(--dim);margin:0 0 18px}
 table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
 th,td{padding:10px 12px;text-align:left;border-bottom:1px solid var(--line);vertical-align:middle}
 th{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--dim)}
 tr:last-child td{border-bottom:0}
 .dim{color:var(--dim)} .num{text-align:center}
 select,button{font:inherit;padding:6px 10px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--ink)}
 button{cursor:pointer;background:var(--accent);color:var(--card);border:0;font-weight:600}
 .inline{display:inline} .badge{display:inline-block;min-width:22px;padding:2px 7px;border-radius:999px;background:#f59e0b;color:#1a1a1a;font-weight:700}
 .msg{margin:0 0 14px;padding:9px 12px;border-radius:8px;background:color-mix(in srgb,var(--accent) 10%,transparent)}
</style></head><body><div class="wrap">
<h1>Faktureringsrytm per kund</h1>
<p class="lead">Kunder med annan rytm än "per order" får sina ordrar parkerade och sammanslagna till en faktura när perioden klipps.</p>
${msg ? `<div class="msg">${esc(msg)}</div>` : ""}
<table>
  <tr><th>Fortnox-kund</th><th>Rytm</th><th>Parkerade</th><th>Senast fakturerad</th><th></th></tr>
  ${body || `<tr><td colspan="5" class="dim">Inga kunder synkade ännu.</td></tr>`}
</table>
</div></body></html>`;
}
