import { INVOICE_MODES, MODE_LABEL } from "../../domain/billing";

export interface BillingRow {
  id: string;
  fortnoxCustomerNumber: string;
  companyId: string;
  companyLocationId: string;
  organisationNumber: string | null;
  invoiceMode: string;
  lastConsolidatedAt: Date | null;
}

export interface BillingViewOptions {
  rows: BillingRow[];
  pendingBy: Map<string, number>;
  /** Dolda fält som följer med varje formulär (auth). */
  hidden: Record<string, string>;
  /** Var formulären postar. */
  actionSet: string;
  actionRun: string;
  msg?: string;
  /** Inbäddad i Shopify-admin → App Bridge + luftigare ram. */
  embedded?: boolean;
  apiKey?: string;
}

const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export function renderBillingView(o: BillingViewOptions): string {
  const hiddenFields = Object.entries(o.hidden)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("");

  const totalPending = [...o.pendingBy.values()].reduce((a, b) => a + b, 0);

  const body = o.rows
    .map((r) => {
      const pending = o.pendingBy.get(r.companyLocationId) ?? 0;
      const opts = INVOICE_MODES.map(
        (m) =>
          `<option value="${m}" ${m === r.invoiceMode ? "selected" : ""}>${MODE_LABEL[m]}</option>`
      ).join("");
      return `<tr>
        <td><strong>${esc(r.fortnoxCustomerNumber)}</strong><br><span class="dim">${esc(r.organisationNumber ?? "—")}</span></td>
        <td>
          <form method="post" action="${esc(o.actionSet)}" class="inline">
            ${hiddenFields}
            <input type="hidden" name="mappingId" value="${esc(r.id)}">
            <select name="mode" onchange="this.form.submit()">${opts}</select>
          </form>
        </td>
        <td class="num">${
          pending > 0
            ? `<span class="badge">${pending}</span>`
            : `<span class="dim">0</span>`
        }</td>
        <td class="dim">${r.lastConsolidatedAt ? r.lastConsolidatedAt.toISOString().slice(0, 10) : "—"}</td>
        <td>${
          pending > 0
            ? `<form method="post" action="${esc(o.actionRun)}" class="inline">
                 ${hiddenFields}
                 <input type="hidden" name="locationId" value="${esc(r.companyLocationId)}">
                 <button>Fakturera nu</button>
               </form>`
            : ""
        }</td>
      </tr>`;
    })
    .join("");

  const appBridge =
    o.embedded && o.apiKey
      ? `<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" data-api-key="${esc(o.apiKey)}"></script>`
      : "";

  return `<!doctype html><html lang="sv"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Faktureringsrytm</title>${appBridge}
<style>
 :root{--bg:#f6f6f7;--card:#fff;--ink:#1a1a1a;--dim:#6b7177;--line:#d9dbde;--accent:#1a1a1a}
 @media(prefers-color-scheme:dark){:root{--bg:#151719;--card:#1e2124;--ink:#f2f3f4;--dim:#a4abb2;--line:#343a3f;--accent:#f2f3f4}}
 body{margin:0;padding:${o.embedded ? "16px" : "28px 16px"};background:${o.embedded ? "transparent" : "var(--bg)"};color:var(--ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
 .wrap{max-width:920px;margin:0 auto}
 h1{font-size:20px;margin:0 0 4px} p.lead{color:var(--dim);margin:0 0 16px}
 table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
 th,td{padding:10px 12px;text-align:left;border-bottom:1px solid var(--line);vertical-align:middle}
 th{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--dim)}
 tr:last-child td{border-bottom:0}
 .dim{color:var(--dim)} .num{text-align:center}
 select,button{font:inherit;padding:6px 10px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--ink)}
 button{cursor:pointer;background:var(--accent);color:var(--card);border:0;font-weight:600}
 .inline{display:inline}
 .badge{display:inline-block;min-width:22px;padding:2px 7px;border-radius:999px;background:#f59e0b;color:#1a1a1a;font-weight:700}
 .msg{margin:0 0 14px;padding:9px 12px;border-radius:8px;background:color-mix(in srgb,var(--accent) 10%,transparent)}
 .sum{margin:0 0 14px;color:var(--dim);font-size:13px}
</style></head><body><div class="wrap">
<h1>Faktureringsrytm per kund</h1>
<p class="lead">Kunder med annan rytm än "per order" får sina ordrar parkerade och sammanslagna till en faktura när perioden klipps. Rytmen sätts på företagssidan (fältet "Faktureringsrytm (Fortnox)") — den kan även ändras här.</p>
${o.msg ? `<div class="msg">${esc(o.msg)}</div>` : ""}
<p class="sum">${o.rows.length} kunder · ${totalPending} ordrar väntar på samlingsfaktura</p>
<table>
  <tr><th>Fortnox-kund</th><th>Rytm</th><th>Parkerade</th><th>Senast fakturerad</th><th></th></tr>
  ${body || `<tr><td colspan="5" class="dim">Inga kunder synkade ännu.</td></tr>`}
</table>
</div></body></html>`;
}
