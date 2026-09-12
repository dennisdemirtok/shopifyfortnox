/**
 * GraphQL-operationer mot Shopify Admin API.
 * Samtliga validerade mot schema 2026-01 via shopify-dev-mcp.
 */

// Flöde A: hämta en CompanyLocation (från company_locations/* webhook).
export const COMPANY_LOCATION_FOR_SYNC = /* GraphQL */ `
query CompanyLocationForSync($id: ID!) {
  companyLocation(id: $id) {
    id
    name
    externalId
    taxSettings { taxRegistrationId taxExempt }
    company {
      id
      name
      externalId
      mainContact { customer { defaultEmailAddress { emailAddress } firstName lastName } }
    }
    billingAddress { address1 address2 city zip countryCode province recipient phone }
    shippingAddress { address1 address2 city zip countryCode }
    buyerExperienceConfiguration { paymentTermsTemplate { id name paymentTermsType dueInDays } }
  }
}`;

// Flöde A: hämta ett Company med alla locations (från companies/* webhook).
export const COMPANY_FOR_SYNC = /* GraphQL */ `
query CompanyForSync($id: ID!) {
  company(id: $id) {
    id
    name
    externalId
    mainContact { customer { defaultEmailAddress { emailAddress } firstName lastName } }
    locations(first: 20) {
      nodes {
        id
        name
        externalId
        taxSettings { taxRegistrationId taxExempt }
        billingAddress { address1 address2 city zip countryCode province recipient phone }
        buyerExperienceConfiguration { paymentTermsTemplate { id name paymentTermsType dueInDays } }
      }
    }
  }
}`;

// Flöde A: skriv tillbaka Fortnox CustomerNumber till Company.externalId.
export const SET_COMPANY_EXTERNAL_ID = /* GraphQL */ `
mutation SetCompanyExternalId($companyId: ID!, $input: CompanyInput!) {
  companyUpdate(companyId: $companyId, input: $input) {
    company { id externalId }
    userErrors { field message }
  }
}`;

// Flöde B: hämta order för fakturering (från orders/fulfilled webhook).
export const ORDER_FOR_INVOICING = /* GraphQL */ `
query OrderForInvoicing($id: ID!) {
  order(id: $id) {
    id
    name
    createdAt
    taxesIncluded
    currencyCode
    note
    billingAddress { countryCodeV2 }
    shippingAddress { countryCodeV2 }
    purchasingEntity {
      __typename
      ... on PurchasingCompany {
        company {
          id
          name
          externalId
          metafield(namespace: "custom", key: "fortnox_invoice_mode") { value }
        }
        location { id name externalId }
      }
    }
    totalShippingPriceSet { shopMoney { amount currencyCode } }
    shippingLines(first: 5) {
      nodes { title originalPriceSet { shopMoney { amount } } taxLines { rate ratePercentage } }
    }
    lineItems(first: 100) {
      nodes {
        id
        sku
        quantity
        title
        originalUnitPriceSet { shopMoney { amount currencyCode } }
        discountedUnitPriceSet { shopMoney { amount } }
        taxLines { rate ratePercentage priceSet { shopMoney { amount } } }
      }
    }
  }
}`;

// Flöde C (import): skapa Company + Location (+ ev. kontakt) från Fortnox-kund.
export const COMPANY_CREATE = /* GraphQL */ `
mutation CompanyCreate($input: CompanyCreateInput!) {
  companyCreate(input: $input) {
    company {
      id
      name
      externalId
      locations(first: 1) { nodes { id } }
    }
    userErrors { field message }
  }
}`;

// Faktureringsrytm: metafältdefinition på Company (ger dropdown i Shopify-admin).
export const METAFIELD_DEFINITION_CREATE = /* GraphQL */ `
mutation CreateInvoiceModeDefinition($definition: MetafieldDefinitionInput!) {
  metafieldDefinitionCreate(definition: $definition) {
    createdDefinition { id name key namespace }
    userErrors { field message code }
  }
}`;

// Faktureringsrytm: skriv värdet på ett företag.
export const METAFIELDS_SET = /* GraphQL */ `
mutation SetInvoiceMode($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    metafields { id key namespace value }
    userErrors { field message code }
  }
}`;

// Faktureringsrytm: läs alla företags nuvarande värde (för adminvy/spegling).
export const COMPANY_INVOICE_MODES = /* GraphQL */ `
query CompanyInvoiceModes($first: Int!, $after: String) {
  companies(first: $first, after: $after) {
    nodes {
      id
      name
      externalId
      metafield(namespace: "custom", key: "fortnox_invoice_mode") { value }
      locations(first: 1) { nodes { id } }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

// Produktsynk: alla produkter + varianter (SKU) för push till Fortnox-artiklar.
export const PRODUCTS_FOR_ARTICLE_SYNC = /* GraphQL */ `
query ProductsForArticleSync($first: Int!, $after: String) {
  products(first: $first, after: $after) {
    nodes {
      id
      title
      status
      variants(first: 100) {
        nodes { id sku title price }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

// B2B-ansökan: riktad sökning för dubblettskydd (billigare än att lista alla).
export const FIND_COMPANIES = /* GraphQL */ `
query FindCompanies($query: String!) {
  companies(first: 5, query: $query) {
    nodes { id name externalId }
  }
}`;

// Flöde C (import): lista alla befintliga companies för dubblettskydd.
export const COMPANIES_FOR_DEDUPE = /* GraphQL */ `
query AllCompaniesForDedupe($first: Int!, $after: String) {
  companies(first: $first, after: $after) {
    nodes {
      id
      name
      externalId
      locations(first: 1) { nodes { id } }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

// Provisionering: skapa webhook-prenumeration (HTTPS-leverans via uri).
export const WEBHOOK_SUBSCRIPTION_CREATE = /* GraphQL */ `
mutation WebhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
    webhookSubscription { id topic format }
    userErrors { field message }
  }
}`;

// Provisionering: ta bort en webhook-prenumeration (t.ex. inaktuell URL).
export const WEBHOOK_SUBSCRIPTION_DELETE = /* GraphQL */ `
mutation WebhookSubscriptionDelete($id: ID!) {
  webhookSubscriptionDelete(id: $id) {
    deletedWebhookSubscriptionId
    userErrors { field message }
  }
}`;

// Provisionering: lista befintliga webhook-prenumerationer.
export const WEBHOOK_SUBSCRIPTIONS = /* GraphQL */ `
query WebhookSubscriptions {
  webhookSubscriptions(first: 100) {
    nodes {
      id
      topic
      uri
    }
  }
}`;
