import { shopifyGraphQL } from "./graphql";
import {
  COMPANY_FOR_SYNC,
  COMPANY_LOCATION_FOR_SYNC,
  ORDER_FOR_INVOICING,
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
