import { env } from "../config/env";
import { logger } from "../lib/logger";
import { acquireFortnoxSlot } from "./throttle";
import { getValidAccessToken, forceRefresh } from "./oauth";
import type {
  FortnoxArticle,
  FortnoxCustomer,
  FortnoxInvoice,
  FortnoxOrder,
} from "./types";

export class FortnoxApiError extends Error {
  constructor(
    public status: number,
    public body: string,
    public path: string
  ) {
    super(`Fortnox ${status} @ ${path}: ${body}`);
    this.name = "FortnoxApiError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_RETRIES = 5;

interface RequestOpts {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string; // t.ex. /3/customers
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

function buildUrl(path: string, query?: RequestOpts["query"]): string {
  const url = new URL(env.FORTNOX_API_BASE + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

async function request<T>(opts: RequestOpts): Promise<T> {
  const url = buildUrl(opts.path, opts.query);
  let attempt = 0;
  let refreshed = false;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt++;
    await acquireFortnoxSlot(); // global throttle: 25/5s delat över allt
    const accessToken = await getValidAccessToken();

    const res = await fetch(url, {
      method: opts.method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });

    if (res.ok) {
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }

    const text = await res.text().catch(() => "");

    // 401: token ogiltig -> tvinga refresh en gång och kör om.
    if (res.status === 401 && !refreshed) {
      refreshed = true;
      logger.warn({ path: opts.path }, "Fortnox 401 — tvingar token-refresh");
      await forceRefresh();
      continue;
    }

    // 429: rate limit -> backoff och kör om.
    if (res.status === 429 && attempt <= MAX_RETRIES) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(500 * 2 ** (attempt - 1), 8000);
      logger.warn({ path: opts.path, waitMs }, "Fortnox 429 — backoff");
      await sleep(waitMs);
      continue;
    }

    // 5xx: tillfälligt -> exponentiell backoff.
    if (res.status >= 500 && attempt <= MAX_RETRIES) {
      const waitMs = Math.min(500 * 2 ** (attempt - 1), 8000);
      logger.warn({ path: opts.path, status: res.status, waitMs }, "Fortnox 5xx — backoff");
      await sleep(waitMs);
      continue;
    }

    throw new FortnoxApiError(res.status, text, opts.path);
  }
}

// ── Kunder ─────────────────────────────────────────────────────────────────
interface CustomersList {
  Customers?: FortnoxCustomer[];
  MetaInformation?: {
    "@TotalResources"?: number;
    "@TotalPages"?: number;
    "@CurrentPage"?: number;
  };
}
interface CustomerEnvelope {
  Customer: FortnoxCustomer;
}

/** Paginerad kundlista (Flöde C: import Fortnox → Shopify). OBS: listan
 * innehåller bara ett fältsubset — hämta detaljer per kund via getCustomer(). */
export async function listCustomers(
  page = 1,
  limit = 100,
  filter?: "active" | "inactive"
): Promise<CustomersList> {
  return request<CustomersList>({
    method: "GET",
    path: "/3/customers",
    query: { page, limit, ...(filter ? { filter } : {}) },
  });
}

/**
 * Hittar en kund på organisationsnummer. Primär idempotens sker via lokal
 * mapping + Shopify externalId; detta är en extra dubbletts-spärr vid första synk.
 * OBS: matchar OrganisationNumber exakt i svaret (defensivt om filtret ignoreras).
 */
export async function findCustomerByOrgNr(
  orgNr: string
): Promise<FortnoxCustomer | null> {
  const data = await request<CustomersList>({
    method: "GET",
    path: "/3/customers",
    query: { organisationnumber: orgNr },
  });
  const list = data.Customers ?? [];
  const norm = (s?: string) => (s ?? "").replace(/\D/g, "");
  const match = list.find((c) => norm(c.OrganisationNumber) === norm(orgNr));
  return match ?? null;
}

export async function getCustomer(customerNumber: string): Promise<FortnoxCustomer> {
  const data = await request<CustomerEnvelope>({
    method: "GET",
    path: `/3/customers/${encodeURIComponent(customerNumber)}`,
  });
  return data.Customer;
}

export async function createCustomer(payload: FortnoxCustomer): Promise<FortnoxCustomer> {
  const data = await request<CustomerEnvelope>({
    method: "POST",
    path: "/3/customers",
    body: { Customer: payload },
  });
  return data.Customer;
}

export async function updateCustomer(
  customerNumber: string,
  payload: FortnoxCustomer
): Promise<FortnoxCustomer> {
  const data = await request<CustomerEnvelope>({
    method: "PUT",
    path: `/3/customers/${encodeURIComponent(customerNumber)}`,
    body: { Customer: payload },
  });
  return data.Customer;
}

// ── Order & faktura ──────────────────────────────────────────────────────
interface OrderEnvelope {
  Order: FortnoxOrder;
}
interface InvoiceEnvelope {
  Invoice: FortnoxInvoice;
}

export async function createOrder(payload: FortnoxOrder): Promise<FortnoxOrder> {
  const data = await request<OrderEnvelope>({
    method: "POST",
    path: "/3/orders",
    body: { Order: payload },
  });
  return data.Order;
}

/** PUT /3/orders/{DocumentNumber}/createinvoice → skapar faktura från order. */
export async function createInvoiceFromOrder(
  orderDocumentNumber: string
): Promise<FortnoxInvoice> {
  const data = await request<InvoiceEnvelope>({
    method: "PUT",
    path: `/3/orders/${encodeURIComponent(orderDocumentNumber)}/createinvoice`,
  });
  return data.Invoice;
}

/** GET /3/invoices/{nr}/email → skickar fakturan via e-post (kräver EmailInformation). */
export async function emailInvoice(invoiceNumber: string): Promise<FortnoxInvoice> {
  const data = await request<InvoiceEnvelope>({
    method: "GET",
    path: `/3/invoices/${encodeURIComponent(invoiceNumber)}/email`,
  });
  return data.Invoice;
}

/** GET /3/invoices/{nr}/eprint → Fortnox skriver ut och postar fysiskt brev. */
export async function eprintInvoice(invoiceNumber: string): Promise<FortnoxInvoice> {
  const data = await request<InvoiceEnvelope>({
    method: "GET",
    path: `/3/invoices/${encodeURIComponent(invoiceNumber)}/eprint`,
  });
  return data.Invoice;
}

/** PUT /3/invoices/{nr}/bookkeep → bokför fakturan. */
export async function bookkeepInvoice(invoiceNumber: string): Promise<FortnoxInvoice> {
  const data = await request<InvoiceEnvelope>({
    method: "PUT",
    path: `/3/invoices/${encodeURIComponent(invoiceNumber)}/bookkeep`,
  });
  return data.Invoice;
}

export async function getInvoice(invoiceNumber: string): Promise<FortnoxInvoice> {
  const data = await request<InvoiceEnvelope>({
    method: "GET",
    path: `/3/invoices/${encodeURIComponent(invoiceNumber)}`,
  });
  return data.Invoice;
}

// ── Artiklar (försynk SKU -> ArticleNumber) ───────────────────────────────
interface ArticlesList {
  Articles?: FortnoxArticle[];
  MetaInformation?: {
    "@TotalResources"?: number;
    "@TotalPages"?: number;
    "@CurrentPage"?: number;
  };
}

export async function listArticles(page = 1, limit = 500): Promise<ArticlesList> {
  return request<ArticlesList>({
    method: "GET",
    path: "/3/articles",
    query: { page, limit },
  });
}

/** Skapar en artikel i Fortnox (produktsynk Shopify → Fortnox). */
export async function createArticle(payload: FortnoxArticle): Promise<FortnoxArticle> {
  const data = await request<{ Article: FortnoxArticle }>({
    method: "POST",
    path: "/3/articles",
    body: { Article: payload },
  });
  return data.Article;
}

/** Uppdaterar en befintlig artikel. */
export async function updateArticle(
  articleNumber: string,
  payload: FortnoxArticle
): Promise<FortnoxArticle> {
  const data = await request<{ Article: FortnoxArticle }>({
    method: "PUT",
    path: `/3/articles/${encodeURIComponent(articleNumber)}`,
    body: { Article: payload },
  });
  return data.Article;
}

export async function getArticle(articleNumber: string): Promise<FortnoxArticle | null> {
  try {
    const data = await request<{ Article: FortnoxArticle }>({
      method: "GET",
      path: `/3/articles/${encodeURIComponent(articleNumber)}`,
    });
    return data.Article;
  } catch (err) {
    if (err instanceof FortnoxApiError && err.status === 404) return null;
    throw err;
  }
}
