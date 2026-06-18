/** Typer för Fortnox-API:t (delmängd vi använder). */

export interface FortnoxTokenResponse {
  access_token: string;
  refresh_token: string;
  scope: string;
  expires_in: number; // sekunder (access token ~3600)
  token_type: string; // "Bearer"
}

export type FortnoxCustomerType = "COMPANY" | "PRIVATE";

/**
 * VATType i Fortnox styr momsbehandling:
 *  - SEVAT: svensk moms
 *  - SEREVERSEDVAT: omvänd skattskyldighet inom Sverige (sällan B2B-utland)
 *  - EUREVERSEDVAT: EU omvänd skattskyldighet (reverse charge)
 *  - EUVAT: EU-moms (varor/tjänster med moms)
 *  - EXPORT: export tredjeland (0 % svensk moms)
 */
export type FortnoxVATType =
  | "SEVAT"
  | "SEREVERSEDVAT"
  | "EUREVERSEDVAT"
  | "EUVAT"
  | "EXPORT";

export interface FortnoxCustomer {
  CustomerNumber?: string;
  Name: string;
  OrganisationNumber?: string;
  Type?: FortnoxCustomerType;
  Address1?: string;
  Address2?: string;
  ZipCode?: string;
  City?: string;
  CountryCode?: string; // ISO 3166-1 alpha-2, t.ex. "SE", "NO"
  Email?: string;
  EmailInvoice?: string;
  Phone1?: string;
  Currency?: string; // "SEK", "NOK", "EUR"
  VATType?: FortnoxVATType;
  VATNumber?: string; // EU-VAT vid reverse charge
  TermsOfPayment?: string; // kod, t.ex. "30"
  DefaultDeliveryTypes?: {
    Invoice?: "PRINT" | "EMAIL" | "PRINTSERVICE";
  };
  EmailInformation?: {
    EmailAddressTo?: string;
    EmailSubject?: string;
    EmailBody?: string;
  };
  Active?: boolean;
}

export interface FortnoxOrderRow {
  ArticleNumber?: string;
  Description?: string;
  OrderedQuantity?: number;
  DeliveredQuantity?: number;
  Price?: number; // exkl. moms (om VATIncluded=false)
  VAT?: number; // momssats i procent, t.ex. 25
  Unit?: string;
  Discount?: number;
  DiscountType?: "AMOUNT" | "PERCENT";
  AccountNumber?: number; // ev. explicit försäljningskonto
}

export interface FortnoxOrder {
  DocumentNumber?: string;
  CustomerNumber: string;
  OrderRows: FortnoxOrderRow[];
  Currency?: string;
  VATIncluded?: boolean; // MÅSTE matcha Shopify taxesIncluded
  YourReference?: string;
  ExternalInvoiceReference1?: string; // Shopify ordernummer för spårbarhet
  TermsOfPayment?: string;
  DeliveryDate?: string;
  OrderDate?: string;
  Freight?: number;
}

export interface FortnoxInvoice {
  DocumentNumber?: string;
  CustomerNumber?: string;
  InvoiceRows?: FortnoxOrderRow[];
  Total?: number;
  Booked?: boolean;
  Sent?: boolean;
  ExternalInvoiceReference1?: string;
  VATIncluded?: boolean;
}

export interface FortnoxArticle {
  ArticleNumber?: string;
  Description?: string;
  Active?: boolean;
  Type?: "STOCK" | "SERVICE";
  SalesAccount?: number;
}
