import { shopifyGraphQL } from "./graphql";
import {
  COMPANIES_FOR_DEDUPE,
  COMPANY_CREATE,
  FIND_COMPANIES,
  COMPANY_FOR_SYNC,
  COMPANY_LOCATION_FOR_SYNC,
  ORDER_FOR_INVOICING,
  PRODUCTS_FOR_ARTICLE_SYNC,
  SET_COMPANY_EXTERNAL_ID,
} from "./queries";
import type { CompanyLocationNode, CompanyNode, OrderNode } from "./types";

/** Bygger en Shopify-GID. T.ex. toGid("Order", 123) -> gid://shopify/Order/123 */
export function toGid(type: string, id: string | number): string {
  return `gid://shopify/${type}/${id}`;
}

/** Säkerställer att ett värde är en GID (webhook ger ofta admin_graphql_api_id direkt). */
export function ensureGid(type: string, value: string | number): string {
  const s = String(value);
  return s.startsWith("gid://") ? s : toGid(type, s);
}

export async function getCompanyLocation(id: string): Promise<CompanyLocationNode | null> {
  const data = await shopifyGraphQL<{ companyLocation: CompanyLocationNode | null }>(
    COMPANY_LOCATION_FOR_SYNC,
    { id }
  );
  return data.companyLocation;
}

export async function getCompany(id: string): Promise<CompanyNode | null> {
  const data = await shopifyGraphQL<{ company: CompanyNode | null }>(COMPANY_FOR_SYNC, {
    id,
  });
  return data.company;
}

export async function getOrder(id: string): Promise<OrderNode | null> {
  const data = await shopifyGraphQL<{ order: OrderNode | null }>(ORDER_FOR_INVOICING, {
    id,
  });
  return data.order;
}

interface CompanyUpdateResult {
  companyUpdate: {
    company: { id: string; externalId: string | null } | null;
    userErrors: Array<{ field: string[] | null; message: string }>;
  };
}

// ── Flöde C: import Fortnox → Shopify ─────────────────────────────────────
export interface CompanySummary {
  id: string;
  name?: string | null;
  externalId?: string | null;
  locations?: { nodes: Array<{ id: string }> } | null;
}

/** Hämtar ALLA companies (paginerat) — används som dubblettskydd vid import. */
export async function listAllCompanies(): Promise<CompanySummary[]> {
  const out: CompanySummary[] = [];
  let after: string | null = null;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const data: {
      companies: {
        nodes: CompanySummary[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    } = await shopifyGraphQL(COMPANIES_FOR_DEDUPE, { first: 250, after });
    out.push(...data.companies.nodes);
    if (!data.companies.pageInfo.hasNextPage) break;
    after = data.companies.pageInfo.endCursor;
  }
  return out;
}

// ── Faktureringsrytm som metafält på Company ──────────────────────────────
import {
  METAFIELD_KEY,
  METAFIELD_NAMESPACE,
  MODE_LABEL,
  INVOICE_MODES,
} from "../domain/billing";
import {
  COMPANY_INVOICE_MODES,
  METAFIELD_DEFINITION_CREATE,
  METAFIELDS_SET,
} from "./queries";

/**
 * Skapar metafältsdefinitionen så att "Faktureringsrytm" dyker upp som en
 * dropdown på företagssidan i Shopify-admin. Idempotent: en redan befintlig
 * definition rapporteras som "fanns redan".
 */
export async function createInvoiceModeDefinition(): Promise<{
  created: boolean;
  message: string;
}> {
  const data = await shopifyGraphQL<{
    metafieldDefinitionCreate: {
      createdDefinition: { id: string } | null;
      userErrors: Array<{ field: string[] | null; message: string; code?: string }>;
    };
  }>(METAFIELD_DEFINITION_CREATE, {
    definition: {
      name: "Faktureringsrytm (Fortnox)",
      namespace: METAFIELD_NAMESPACE,
      key: METAFIELD_KEY,
      description:
        "Styr om kunden faktureras per order eller får en samlingsfaktura per period.",
      type: "single_line_text_field",
      ownerType: "COMPANY",
      pin: true,
      validations: [
        { name: "choices", value: JSON.stringify(INVOICE_MODES) },
      ],
    },
  });
  const errs = data.metafieldDefinitionCreate.userErrors ?? [];
  if (errs.length > 0) {
    const taken = errs.some((e) => (e.code ?? "").includes("TAKEN"));
    if (taken) return { created: false, message: "Definitionen fanns redan." };
    throw new Error(errs.map((e) => e.message).join("; "));
  }
  return { created: true, message: "Definitionen skapad." };
}

/** Sätter faktureringsrytmen på ett företag (Shopify är sanningen). */
export async function setCompanyInvoiceMode(
  companyId: string,
  mode: string
): Promise<void> {
  const data = await shopifyGraphQL<{
    metafieldsSet: {
      userErrors: Array<{ field: string[] | null; message: string }>;
    };
  }>(METAFIELDS_SET, {
    metafields: [
      {
        ownerId: companyId,
        namespace: METAFIELD_NAMESPACE,
        key: METAFIELD_KEY,
        type: "single_line_text_field",
        value: mode,
      },
    ],
  });
  const errs = data.metafieldsSet.userErrors ?? [];
  if (errs.length > 0) throw new Error(errs.map((e) => e.message).join("; "));
}

export interface CompanyMode {
  id: string;
  name?: string | null;
  externalId?: string | null;
  mode?: string | null;
  locationId?: string;
}

/** Läser alla företags faktureringsrytm (för spegling till vår DB). */
export async function listCompanyInvoiceModes(): Promise<CompanyMode[]> {
  const out: CompanyMode[] = [];
  let after: string | null = null;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const data: {
      companies: {
        nodes: Array<{
          id: string;
          name?: string | null;
          externalId?: string | null;
          metafield?: { value?: string | null } | null;
          locations?: { nodes: Array<{ id: string }> } | null;
        }>;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    } = await shopifyGraphQL(COMPANY_INVOICE_MODES, { first: 100, after });
    for (const n of data.companies.nodes) {
      out.push({
        id: n.id,
        name: n.name,
        externalId: n.externalId,
        mode: n.metafield?.value ?? null,
        locationId: n.locations?.nodes?.[0]?.id,
      });
    }
    if (!data.companies.pageInfo.hasNextPage) break;
    after = data.companies.pageInfo.endCursor;
  }
  return out;
}

export { MODE_LABEL };

// ── Produktsynk ───────────────────────────────────────────────────────────
export interface ShopifyVariant {
  id: string;
  sku?: string | null;
  title?: string | null;
  price?: string | null;
}
export interface ShopifyProduct {
  id: string;
  title: string;
  status: string;
  variants: { nodes: ShopifyVariant[] };
}

/** Hämtar alla produkter med varianter (paginerat). */
export async function listAllProducts(): Promise<ShopifyProduct[]> {
  const out: ShopifyProduct[] = [];
  let after: string | null = null;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const data: {
      products: {
        nodes: ShopifyProduct[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    } = await shopifyGraphQL(PRODUCTS_FOR_ARTICLE_SYNC, { first: 50, after });
    out.push(...data.products.nodes);
    if (!data.products.pageInfo.hasNextPage) break;
    after = data.products.pageInfo.endCursor;
  }
  return out;
}

/** Riktad sökning bland companies (dubblettskydd vid B2B-ansökan). */
export async function findCompanies(query: string): Promise<CompanySummary[]> {
  const data = await shopifyGraphQL<{ companies: { nodes: CompanySummary[] } }>(
    FIND_COMPANIES,
    { query }
  );
  return data.companies.nodes;
}

export interface CompanyCreatePayload {
  company: {
    id: string;
    name?: string | null;
    externalId?: string | null;
    locations?: { nodes: Array<{ id: string }> } | null;
  } | null;
  userErrors: Array<{ field: string[] | null; message: string }>;
}

/** Skapar ett Company (+ location + ev. kontakt) via companyCreate. */
export async function createCompany(
  input: Record<string, unknown>
): Promise<CompanyCreatePayload> {
  const data = await shopifyGraphQL<{ companyCreate: CompanyCreatePayload }>(
    COMPANY_CREATE,
    { input }
  );
  return data.companyCreate;
}

/** Skriver tillbaka Fortnox CustomerNumber till Company.externalId. */
export async function setCompanyExternalId(
  companyId: string,
  externalId: string
): Promise<void> {
  const data = await shopifyGraphQL<CompanyUpdateResult>(SET_COMPANY_EXTERNAL_ID, {
    companyId,
    input: { externalId },
  });
  const errs = data.companyUpdate.userErrors;
  if (errs && errs.length > 0) {
    throw new Error(
      `companyUpdate userErrors: ${errs.map((e) => e.message).join("; ")}`
    );
  }
}
