/** Parsade typer från Shopify Admin GraphQL (delmängd vi använder). */

export interface ShopifyAddress {
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  zip?: string | null;
  countryCode?: string | null; // ISO alpha-2 (CountryCode enum), t.ex. "SE"
  province?: string | null;
  recipient?: string | null;
  phone?: string | null;
}

export interface PaymentTermsTemplate {
  id: string;
  name?: string | null;
  paymentTermsType?: string | null;
  dueInDays?: number | null;
}

export interface BuyerExperienceConfiguration {
  paymentTermsTemplate?: PaymentTermsTemplate | null;
}

export interface CompanyContactInfo {
  customer?: {
    defaultEmailAddress?: { emailAddress?: string | null } | null;
    firstName?: string | null;
    lastName?: string | null;
  } | null;
}

export interface CompanyLocationNode {
  id: string;
  name?: string | null;
  externalId?: string | null;
  taxSettings?: { taxRegistrationId?: string | null; taxExempt?: boolean | null } | null;
  company?: {
    id: string;
    name?: string | null;
    externalId?: string | null;
    mainContact?: CompanyContactInfo | null;
  } | null;
  billingAddress?: ShopifyAddress | null;
  shippingAddress?: ShopifyAddress | null;
  buyerExperienceConfiguration?: BuyerExperienceConfiguration | null;
}

export interface CompanyNode {
  id: string;
  name?: string | null;
  externalId?: string | null;
  mainContact?: {
    customer?: {
      defaultEmailAddress?: { emailAddress?: string | null } | null;
      firstName?: string | null;
      lastName?: string | null;
    } | null;
  } | null;
  locations?: { nodes: CompanyLocationNode[] } | null;
}

export interface MoneyBag {
  shopMoney: { amount: string; currencyCode?: string };
}

export interface OrderLineItemNode {
  id: string;
  sku?: string | null;
  quantity: number;
  title: string;
  originalUnitPriceSet?: MoneyBag | null;
  discountedUnitPriceSet?: MoneyBag | null;
  taxLines: Array<{
    rate?: number | null;
    ratePercentage?: number | null;
    priceSet?: MoneyBag | null;
  }>;
}

export interface PurchasingCompany {
  __typename: "PurchasingCompany";
  company: {
    id: string;
    name?: string | null;
    externalId?: string | null;
    /** custom.fortnox_invoice_mode — styr samlingsfakturering, satt i Shopify-admin. */
    metafield?: { value?: string | null } | null;
  };
  location: { id: string; name?: string | null; externalId?: string | null };
}

export interface OrderNode {
  id: string;
  name: string;
  createdAt: string;
  taxesIncluded: boolean;
  currencyCode: string;
  note?: string | null;
  billingAddress?: { countryCodeV2?: string | null } | null;
  shippingAddress?: { countryCodeV2?: string | null } | null;
  purchasingEntity?: PurchasingCompany | { __typename: string } | null;
  totalShippingPriceSet?: MoneyBag | null;
  shippingLines?: {
    nodes: Array<{
      title?: string | null;
      originalPriceSet?: MoneyBag | null;
      taxLines: Array<{ rate?: number | null; ratePercentage?: number | null }>;
    }>;
  } | null;
  lineItems: { nodes: OrderLineItemNode[] };
}

export function isPurchasingCompany(
  e: OrderNode["purchasingEntity"]
): e is PurchasingCompany {
  return !!e && e.__typename === "PurchasingCompany";
}
